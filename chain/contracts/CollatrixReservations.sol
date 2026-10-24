// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract CollatrixReservations {
    uint256 public constant BASIS_POINTS = 10_000;
    uint256 public constant MAX_PRICE_AGE_SECONDS = 300;
    uint256 public constant MAX_BATCH_ASSETS = 16;

    address public immutable owner;
    address public immutable counterparty;
    uint256 public configurationVersion;

    enum Status {
        Unknown,
        Active,
        Released,
        Expired
    }

    struct AssetState {
        uint256 inventory;
        uint256 reserved;
        uint256 priceCents;
        uint16 haircutBps;
        uint64 updatedAt;
        bool enabled;
    }

    struct ObligationState {
        uint256 requirementCents;
        uint64 expiresAt;
        bool enabled;
    }

    struct Allocation {
        bytes32 assetId;
        uint256 quantity;
    }

    struct Reservation {
        bytes32 obligationId;
        uint64 expiresAt;
        Status status;
        Allocation[] allocations;
    }

    mapping(bytes32 => AssetState) private assets;
    mapping(bytes32 => ObligationState) public obligations;
    mapping(bytes32 => mapping(bytes32 => bool)) public eligible;
    mapping(bytes32 => Reservation) private reservations;
    mapping(bytes32 => bytes32) public activeReservationForObligation;

    event ConfigurationChanged(uint256 indexed version);
    event AssetConfigured(bytes32 indexed assetId, uint256 inventory, uint256 priceCents, uint16 haircutBps);
    event ObligationConfigured(bytes32 indexed obligationId, uint256 requirementCents, uint64 expiresAt);
    event EligibilityConfigured(bytes32 indexed obligationId, bytes32 indexed assetId, bool allowed);
    event ReservationCreated(
        bytes32 indexed reservationId,
        bytes32 indexed obligationId,
        uint256 creditedValueCents,
        uint256 configurationVersion
    );
    event ReservationReleased(bytes32 indexed reservationId);
    event ReservationExpired(bytes32 indexed reservationId);

    modifier onlyOwner() {
        require(msg.sender == owner, "only owner");
        _;
    }

    modifier onlyCounterparty() {
        require(msg.sender == counterparty, "only counterparty");
        _;
    }

    constructor(address counterpartyAddress) {
        require(counterpartyAddress != address(0), "invalid counterparty");
        owner = msg.sender;
        counterparty = counterpartyAddress;
    }

    function configureAsset(
        bytes32 assetId,
        uint256 inventory,
        uint256 priceCents,
        uint16 haircutBps
    ) external onlyOwner {
        AssetState storage asset = assets[assetId];
        require(inventory >= asset.reserved, "inventory below reserved");
        require(priceCents > 0, "price must be positive");
        require(haircutBps < BASIS_POINTS, "invalid haircut");
        asset.inventory = inventory;
        asset.priceCents = priceCents;
        asset.haircutBps = haircutBps;
        asset.updatedAt = uint64(block.timestamp);
        asset.enabled = true;
        _incrementVersion();
        emit AssetConfigured(assetId, inventory, priceCents, haircutBps);
    }

    function configureObligation(
        bytes32 obligationId,
        uint256 requirementCents,
        uint64 expiresAt
    ) external onlyOwner {
        require(requirementCents > 0, "requirement must be positive");
        require(expiresAt > block.timestamp, "expiry must be in future");
        obligations[obligationId] = ObligationState(requirementCents, expiresAt, true);
        _incrementVersion();
        emit ObligationConfigured(obligationId, requirementCents, expiresAt);
    }

    function configureEligibility(bytes32 obligationId, bytes32 assetId, bool allowed) external onlyOwner {
        require(obligations[obligationId].enabled, "obligation not configured");
        require(assets[assetId].enabled, "asset not configured");
        eligible[obligationId][assetId] = allowed;
        _incrementVersion();
        emit EligibilityConfigured(obligationId, assetId, allowed);
    }

    function assetState(bytes32 assetId) external view returns (AssetState memory) {
        return assets[assetId];
    }

    function reservation(bytes32 reservationId) external view returns (Reservation memory) {
        return reservations[reservationId];
    }

    function availableUnits(bytes32 assetId) external view returns (uint256) {
        AssetState storage asset = assets[assetId];
        return asset.inventory - asset.reserved;
    }

    function reserveBatch(
        bytes32 reservationId,
        bytes32 obligationId,
        Allocation[] calldata allocations,
        uint256 expectedVersion
    ) external onlyOwner {
        require(reservations[reservationId].status == Status.Unknown, "duplicate reservation");
        require(activeReservationForObligation[obligationId] == bytes32(0), "obligation already reserved");
        require(expectedVersion == configurationVersion, "stale configuration");
        require(allocations.length > 0 && allocations.length <= MAX_BATCH_ASSETS, "invalid batch size");

        ObligationState storage obligation = obligations[obligationId];
        require(obligation.enabled, "obligation not configured");
        require(block.timestamp < obligation.expiresAt, "obligation expired");

        uint256 totalCreditedValueCents;
        for (uint256 i = 0; i < allocations.length; i++) {
            Allocation calldata item = allocations[i];
            require(item.quantity > 0, "quantity must be positive");

            for (uint256 j = 0; j < i; j++) {
                require(allocations[j].assetId != item.assetId, "duplicate asset in batch");
            }

            AssetState storage asset = assets[item.assetId];
            require(asset.enabled, "asset not configured");
            require(eligible[obligationId][item.assetId], "ineligible collateral");
            require(block.timestamp <= uint256(asset.updatedAt) + MAX_PRICE_AGE_SECONDS, "stale price");
            require(item.quantity <= asset.inventory - asset.reserved, "insufficient inventory");

            uint256 valuePerUnitCents = asset.priceCents * (BASIS_POINTS - asset.haircutBps) / BASIS_POINTS;
            totalCreditedValueCents += valuePerUnitCents * item.quantity;
        }

        require(totalCreditedValueCents >= obligation.requirementCents, "insufficient collateral value");

        Reservation storage newReservation = reservations[reservationId];
        newReservation.obligationId = obligationId;
        newReservation.expiresAt = obligation.expiresAt;
        newReservation.status = Status.Active;
        for (uint256 i = 0; i < allocations.length; i++) {
            Allocation calldata item = allocations[i];
            assets[item.assetId].reserved += item.quantity;
            newReservation.allocations.push(item);
        }
        activeReservationForObligation[obligationId] = reservationId;
        emit ReservationCreated(reservationId, obligationId, totalCreditedValueCents, configurationVersion);
    }

    function release(bytes32 reservationId) external onlyCounterparty {
        Reservation storage current = reservations[reservationId];
        require(current.status == Status.Active, "reservation not active");
        require(block.timestamp < current.expiresAt, "reservation expired");
        _clearReservation(current, Status.Released);
        emit ReservationReleased(reservationId);
    }

    function expire(bytes32 reservationId) external {
        Reservation storage current = reservations[reservationId];
        require(current.status == Status.Active, "reservation not active");
        require(block.timestamp >= current.expiresAt, "reservation not expired");
        _clearReservation(current, Status.Expired);
        emit ReservationExpired(reservationId);
    }

    function _clearReservation(Reservation storage current, Status finalStatus) private {
        for (uint256 i = 0; i < current.allocations.length; i++) {
            Allocation storage item = current.allocations[i];
            assets[item.assetId].reserved -= item.quantity;
        }
        delete activeReservationForObligation[current.obligationId];
        current.status = finalStatus;
    }

    function _incrementVersion() private {
        configurationVersion++;
        emit ConfigurationChanged(configurationVersion);
    }
}
