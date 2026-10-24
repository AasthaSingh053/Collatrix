import unittest

from collatrix.optimizer import compare_allocations
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


if __name__ == "__main__":
    unittest.main()
