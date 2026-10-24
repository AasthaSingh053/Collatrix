import unittest

from collatrix.optimizer import (
    ASSETS,
    OBLIGATIONS,
    BASIS_POINTS,
    AllocationError,
    Asset,
    Obligation,
    compare_allocations,
    false_shortfall_scenario,
    greedy_allocation,
    optimize_allocation,
)


class AllocationTests(unittest.TestCase):
    def test_conservative_haircut_rounding_is_per_unit_floor(self):
        asset = Asset("ROUND", 1_001, 100, 1, 5, ("A",))
        self.assertEqual(asset.credited_value_cents, 990)
        self.assertEqual(asset.unit_value_cents * (BASIS_POINTS - asset.haircut_bps), 9_909_900)

    def test_requirement_uses_integer_units_and_never_under_collateralizes(self):
        asset = Asset("ROUND", 1_001, 100, 1, 5, ("A",))
        result = optimize_allocation((asset,), (Obligation("A", "Rounding case", 991),))
        self.assertEqual(result["asset_usage"], {"ROUND": 2})
        self.assertEqual(result["obligations"][0]["credited_collateral_cents"], 1_980)
        self.assertGreaterEqual(
            result["obligations"][0]["credited_collateral_cents"],
            result["obligations"][0]["requirement_cents"],
        )

    def test_optimizer_matches_independent_integer_enumeration(self):
        result = optimize_allocation()
        # Enumerate all possible shared-cash splits. For each split, the minimum
        # eligible bond quantities are independently derived with integer ceiling.
        best_cost = None
        for cash_a in range(ASSETS[0].inventory + 1):
            for cash_b in range(ASSETS[0].inventory - cash_a + 1):
                ust = max(
                    0,
                    (
                        OBLIGATIONS[0].requirement_cents
                        - cash_a * ASSETS[0].credited_value_cents
                        + ASSETS[1].credited_value_cents
                        - 1
                    )
                    // ASSETS[1].credited_value_cents,
                )
                corp = max(
                    0,
                    (
                        OBLIGATIONS[1].requirement_cents
                        - cash_b * ASSETS[0].credited_value_cents
                        + ASSETS[2].credited_value_cents
                        - 1
                    )
                    // ASSETS[2].credited_value_cents,
                )
                if ust <= ASSETS[1].inventory and corp <= ASSETS[2].inventory:
                    cost = (
                        cash_a * ASSETS[0].unit_cost_cents
                        + cash_b * ASSETS[0].unit_cost_cents
                        + ust * ASSETS[1].unit_cost_cents
                        + corp * ASSETS[2].unit_cost_cents
                    )
                    best_cost = cost if best_cost is None else min(best_cost, cost)

        self.assertEqual(best_cost, 212)
        self.assertEqual(result["total_funding_cost_cents"], best_cost)
        self.assertEqual(result["asset_usage"], {"CASH": 150, "UST": 31, "CORP": 0})

    def test_greedy_calculation_is_deterministic_and_order_independent(self):
        comparison = compare_allocations()
        reversed_input = greedy_allocation(tuple(reversed(ASSETS)), tuple(reversed(OBLIGATIONS)))
        self.assertEqual(comparison["greedy"], reversed_input)
        self.assertEqual(comparison["greedy"]["total_funding_cost_cents"], 406)
        self.assertEqual(comparison["greedy"]["asset_usage"], {"CASH": 150, "UST": 0, "CORP": 32})
        self.assertEqual(comparison["savings_cents"], 194)
        self.assertEqual(comparison["savings_bps"], 4_778)

    def test_both_methods_respect_the_same_eligibility_and_finite_inventory(self):
        comparison = compare_allocations()
        for plan in (comparison["optimized"], comparison["greedy"]):
            for asset in ASSETS:
                self.assertLessEqual(plan["asset_usage"][asset.symbol], asset.inventory)
            for obligation in plan["obligations"]:
                for line in obligation["allocations"]:
                    asset = next(item for item in ASSETS if item.symbol == line["asset"])
                    self.assertIn(obligation["id"], asset.eligible_obligations)
                    self.assertIsInstance(line["quantity"], int)
                self.assertGreaterEqual(
                    obligation["credited_collateral_cents"],
                    obligation["requirement_cents"],
                )
                for line in obligation["allocations"]:
                    self.assertTrue(line["explanation"])

    def test_false_shortfall_scenario_has_a_feasible_global_reallocation(self):
        scenario = false_shortfall_scenario()
        best_independent_cost = None
        for cash_a in range(101):
            for cash_b in range(101 - cash_a):
                ust = max(0, (100_000 - cash_a * 1_000 + 979) // 980)
                if ust <= 80 and cash_b * 1_000 >= 78_000:
                    cost = cash_a + cash_b + 2 * ust
                    best_independent_cost = (
                        cost if best_independent_cost is None else min(best_independent_cost, cost)
                    )

        self.assertEqual(best_independent_cost, 260)
        self.assertTrue(scenario["optimized_feasible"])
        self.assertEqual(scenario["optimized"]["total_funding_cost_cents"], best_independent_cost)
        self.assertFalse(scenario["greedy_feasible"])
        self.assertEqual(scenario["greedy_shortfall_cents"], 78_000)
        self.assertEqual(
            scenario["optimized"]["asset_usage"],
            {"CASH": 100, "CORP": 0, "UST": 80},
        )

    def test_infeasible_inventory_and_invalid_asset_inputs_are_rejected(self):
        assets = (Asset("CASH", 1_000, 0, 1, 1, ("A",)),)
        obligations = (Obligation("A", "Test obligation", 2_000),)
        with self.assertRaises(AllocationError):
            optimize_allocation(assets, obligations)
        with self.assertRaises(AllocationError):
            greedy_allocation(assets, obligations)
        with self.assertRaises(ValueError):
            optimize_allocation((Asset("BAD", 100, BASIS_POINTS, 1, 2, ("A",)),), obligations)
        with self.assertRaises(ValueError):
            optimize_allocation((Asset("FLOAT", 1_000.5, 0, 1, 2, ("A",)),), obligations)
        with self.assertRaises(ValueError):
            optimize_allocation(assets, (Obligation("A", "Float requirement", 1.5),))


if __name__ == "__main__":
    unittest.main()
