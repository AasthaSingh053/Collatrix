import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from main import app


class OptimizationApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    def test_health_and_optimization_return_simulation_data_in_integer_cents(self):
        health = self.client.get("/api/health")
        response = self.client.get("/api/v1/optimize")
        self.assertEqual(health.status_code, 200)
        self.assertEqual(health.json(), {"status": "ok", "mode": "simulation"})
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["mode"], "simulation")
        self.assertEqual(body["currency"], "USD")
        self.assertEqual(body["amount_unit"], "integer cents")
        self.assertEqual(body["optimized"]["total_funding_cost_cents"], 212)
        self.assertEqual(body["greedy"]["total_funding_cost_cents"], 406)
        self.assertEqual(body["savings_cents"], 194)
        self.assertEqual(body["savings_bps"], 4_778)
        self.assertEqual(body["optimized"]["asset_usage"], {"CASH": 150, "UST": 31, "CORP": 0})
        self.assertTrue(body["false_shortfall_scenario"]["optimized_feasible"])
        self.assertFalse(body["false_shortfall_scenario"]["greedy_feasible"])
        self.assertEqual(body["false_shortfall_scenario"]["optimized"]["total_funding_cost_cents"], 260)
        self.assertEqual(body["false_shortfall_scenario"]["greedy_shortfall_cents"], 78_000)

    def test_openapi_exposes_typed_response_contract(self):
        schema = self.client.get("/openapi.json").json()
        self.assertIn("/api/v1/optimize", schema["paths"])
        self.assertIn("OptimizationResponse", schema["components"]["schemas"])

    def test_stress_endpoint_uses_integer_basis_points(self):
        response = self.client.post(
            "/api/v1/stress",
            json={"shocks_bps": {"CASH": 0, "UST": -1_500, "CORP": -2_500}},
        )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["mode"], "simulation")
        self.assertGreater(body["total_shortfall_cents"], 0)
        self.assertTrue(body["top_up_feasible"])
        self.assertIsInstance(body["top_up_cost_cents"], int)

    def test_stress_endpoint_returns_standard_error_envelope(self):
        unknown = self.client.post(
            "/api/v1/stress",
            json={"shocks_bps": {"UNKNOWN": 100}},
        )
        fractional = self.client.post(
            "/api/v1/stress",
            json={"shocks_bps": {"CASH": -0.5}},
        )
        self.assertEqual(unknown.status_code, 422)
        self.assertEqual(unknown.json()["error"]["code"], "invalid_request")
        self.assertEqual(fractional.status_code, 422)
        self.assertEqual(fractional.json()["error"]["code"], "invalid_request")

    def test_dashboard_returns_typed_real_backend_stress_result(self):
        response = self.client.get("/api/v1/dashboard")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["optimized"]["total_funding_cost_cents"], 212)
        self.assertEqual(body["stress"]["mode"], "simulation")
        self.assertGreater(body["stress"]["total_shortfall_cents"], 0)

    def test_missing_local_deployment_is_an_explicit_error(self):
        missing_path = Path(__file__).with_name("deployment-that-does-not-exist.json")
        with patch("main.DEPLOYMENT_PATH", missing_path):
            response = self.client.get("/api/v1/deployment")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["error"]["code"], "http_error")


if __name__ == "__main__":
    unittest.main()
