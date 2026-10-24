import unittest

from collatrix.optimizer import Asset, Obligation, compare_allocations, optimize_allocation
from collatrix.stress import run_stress_test


class StressTests(unittest.TestCase):
    def test_price_shock_calculates_shortfall_and_feasible_top_up(self):
        result = run_stress_test(
            compare_allocations(),
            {"CASH": 0, "UST": -1_500, "CORP": -2_500},
        )
        self.assertGreater(result["total_shortfall_cents"], 0)
        self.assertTrue(result["top_up_feasible"])
        self.assertGreater(result["top_up_cost_cents"], 0)
        self.assertTrue(result["top_up_allocations"])
        self.assertTrue(
            all(
                item["credited_collateral_cents"] >= item["requirement_cents"]
                for item in result["top_up_allocations"]
            )
        )

    def test_no_shock_needs_no_top_up(self):
        result = run_stress_test(compare_allocations(), {})
        self.assertEqual(result["total_shortfall_cents"], 0)
        self.assertTrue(result["top_up_feasible"])
        self.assertEqual(result["top_up_cost_cents"], 0)

    def test_extreme_shock_reports_infeasible_top_up(self):
        result = run_stress_test(
            compare_allocations(),
            {"CASH": -10_000, "UST": -10_000, "CORP": -10_000},
        )
        self.assertGreater(result["total_shortfall_cents"], 0)
        self.assertFalse(result["top_up_feasible"])
        self.assertIsNone(result["top_up_cost_cents"])

    def test_shocked_price_and_haircut_use_conservative_integer_rounding(self):
        assets = (Asset("ROUND", 1_001, 0, 1, 3, ("A",)),)
        obligations = (Obligation("A", "Rounding obligation", 1_001),)
        comparison = {"optimized": optimize_allocation(assets, obligations)}
        result = run_stress_test(comparison, {"ROUND": -1}, assets, obligations)
        self.assertEqual(result["obligations"][0]["stressed_collateral_cents"], 1_000)
        self.assertEqual(result["obligations"][0]["shortfall_cents"], 1)
        self.assertEqual(result["top_up_cost_cents"], 1)

    def test_fractional_or_unconfigured_shocks_are_rejected(self):
        with self.assertRaises(ValueError):
            run_stress_test(compare_allocations(), {"UST": -0.5})
        with self.assertRaises(ValueError):
            run_stress_test(compare_allocations(), {"UNKNOWN": -1})


if __name__ == "__main__":
    unittest.main()
