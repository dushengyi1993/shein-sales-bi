from __future__ import annotations

import unittest

import build_marketing_cost_map as model


def storage_row(canonical: str, fee: float, quantity: float, date: str = "2026-08-10") -> dict:
    return {
        "date": date,
        "standard_goods_sn": canonical,
        "storage_fee_sar": fee,
        "storage_quantity": quantity,
        "storage_fee_per_unit_sar": fee / quantity if quantity else None,
        "storage_fee_method": "download_detail",
    }


def inventory_row(
    canonical: str,
    sellable: float | None,
    *,
    damaged: float = 0,
    status: str = "matched",
    date: str = "2026-08-10",
    store_date: str | None = None,
    box_date: str | None = None,
    policy: str = "09_loose_only",
) -> dict:
    return {
        "standard_goods_sn": canonical,
        "match_key": model.compact(canonical),
        "inventory_match_status": status,
        "current_sellable_quantity": sellable,
        "et_damaged_qty": damaged,
        "et_store_snapshot_date": date if store_date is None else store_date,
        "et_box_snapshot_date": date if box_date is None else box_date,
        "et_operational_stock_policy": policy,
    }


class MarketingStorageAllocationTests(unittest.TestCase):
    def build(self, storage_rows: list[dict], inventory_rows: list[dict]) -> dict[str, dict]:
        return model.build_storage_unit_map({
            "profit": {"productStorageDaily": storage_rows},
            "inventoryDepletion": {"products": inventory_rows},
        })

    def test_unitized_box_quantity_passes_crosscheck(self):
        result = self.build(
            [storage_row("SK-03038制冰机", 157.6237, 96)],
            [inventory_row(
                "SK-03038制冰机",
                96,
                policy="09_loose_plus_01_full_carton_exception",
            )],
        )[model.compact("SK-03038制冰机")]

        self.assertEqual(result["storageCurrentQuantity"], 96)
        self.assertEqual(result["storageBilledCurrentQuantity"], 96)
        self.assertEqual(result["storageOperationalPhysicalQuantity"], 96)
        self.assertEqual(result["storageAllocationQuantity"], 96)
        self.assertEqual(result["storageUnitCostSar"], 1.6419)
        self.assertEqual(result["storageUnitCostCandidateSar"], 1.6419)
        self.assertEqual(result["storageAllocationQuantitySource"], "unitized_storage_daily_billed_current_quantity")
        self.assertEqual(result["storageQuantityEvidenceStatus"], "fresh_quantity_crosscheck_passed")
        self.assertEqual(
            result["storageUnitBasis"],
            "moving_average_remaining_inventory_storage_cost_over_unitized_billed_inventory",
        )

    def test_ununitized_box_quantity_fails_closed(self):
        result = self.build(
            [storage_row("SK-03038制冰机", 157.6237, 2)],
            [inventory_row(
                "SK-03038制冰机",
                96,
                policy="09_loose_plus_01_full_carton_exception",
            )],
        )[model.compact("SK-03038制冰机")]

        self.assertIsNone(result["storageUnitCostSar"])
        self.assertEqual(result["storageUnitCostCandidateSar"], 78.8119)
        self.assertIsNone(result["storageAllocationQuantity"])
        self.assertEqual(result["storageQuantityEvidenceStatus"], "inventory_storage_quantity_mismatch")
        self.assertEqual(result["storageAllocationQuantitySource"], "blocked_inventory_storage_quantity_mismatch")
        self.assertEqual(result["storageUnitBasis"], "suspect_quantity_evidence_fail_closed")

    def test_tolerates_bounded_intra_day_quantity_difference(self):
        result = self.build(
            [storage_row("SM-505A电动缝纫机", 152.68, 80)],
            [inventory_row("SM-505A电动缝纫机", 76)],
        )[model.compact("SM-505A电动缝纫机")]

        self.assertEqual(result["storageAllocationQuantity"], 80)
        self.assertEqual(result["storageUnitCostSar"], 1.9085)
        self.assertEqual(result["storageAllocationQuantitySource"], "unitized_storage_daily_billed_current_quantity")
        self.assertEqual(result["storageQuantityEvidenceStatus"], "fresh_quantity_crosscheck_passed")
        self.assertEqual(result["storageQuantityRelativeDifference"], 0.05)

    def test_new_arrival_cannot_dilute_unbilled_storage_balance(self):
        result = self.build(
            [storage_row("NEW-ARRIVAL", 1000, 100)],
            [inventory_row("NEW-ARRIVAL", 1000)],
        )[model.compact("NEW-ARRIVAL")]

        self.assertIsNone(result["storageUnitCostSar"])
        self.assertEqual(result["storageUnitCostCandidateSar"], 10)
        self.assertEqual(result["storageQuantityEvidenceStatus"], "inventory_storage_quantity_mismatch")

    def test_damaged_inventory_is_part_of_crosscheck(self):
        result = self.build(
            [storage_row("DAMAGED-STOCK", 100, 100)],
            [inventory_row("DAMAGED-STOCK", 90, damaged=10)],
        )[model.compact("DAMAGED-STOCK")]

        self.assertEqual(result["storageOperationalPhysicalQuantity"], 100)
        self.assertEqual(result["storageAllocationQuantity"], 100)
        self.assertEqual(result["storageUnitCostSar"], 1)

    def test_stale_inventory_does_not_dilute_storage_balance(self):
        result = self.build(
            [storage_row("STALE-STOCK", 100, 2, date="2026-08-10")],
            [inventory_row("STALE-STOCK", 100, date="2026-08-01")],
        )[model.compact("STALE-STOCK")]

        self.assertIsNone(result["storageAllocationQuantity"])
        self.assertIsNone(result["storageUnitCostSar"])
        self.assertEqual(result["storageUnitCostCandidateSar"], 50)
        self.assertEqual(result["storageQuantityEvidenceStatus"], "inventory_storage_date_mismatch")
        self.assertEqual(result["storageQuantityDateGapDays"], 9)

    def test_unmatched_inventory_does_not_dilute_storage_balance(self):
        result = self.build(
            [storage_row("UNMATCHED-STOCK", 80, 2)],
            [inventory_row("UNMATCHED-STOCK", 100, status="not_matched")],
        )[model.compact("UNMATCHED-STOCK")]

        self.assertIsNone(result["storageAllocationQuantity"])
        self.assertIsNone(result["storageUnitCostSar"])
        self.assertEqual(result["storageUnitCostCandidateSar"], 40)
        self.assertEqual(result["storageQuantityEvidenceStatus"], "inventory_not_fresh_matched")

    def test_full_carton_blend_uses_older_contributing_snapshot(self):
        result = self.build(
            [storage_row("FULL-CARTON-BLEND", 100, 2)],
            [inventory_row(
                "FULL-CARTON-BLEND",
                100,
                store_date="2026-08-01",
                box_date="2026-08-10",
                policy="09_loose_plus_01_full_carton_exception",
            )],
        )[model.compact("FULL-CARTON-BLEND")]

        self.assertIsNone(result["storageAllocationQuantity"])
        self.assertIsNone(result["storageUnitCostSar"])
        self.assertEqual(result["storageUnitCostCandidateSar"], 50)
        self.assertEqual(result["storageQuantityEvidenceStatus"], "inventory_storage_date_mismatch")
        self.assertEqual(result["storageQuantityDateGapDays"], 9)

    def test_loose_only_policy_requires_store_snapshot(self):
        result = self.build(
            [storage_row("LOOSE-ONLY", 10, 10)],
            [inventory_row(
                "LOOSE-ONLY",
                10,
                store_date="",
                box_date="2026-08-10",
                policy="09_loose_only",
            )],
        )[model.compact("LOOSE-ONLY")]

        self.assertIsNone(result["storageUnitCostSar"])
        self.assertEqual(result["storageQuantityEvidenceStatus"], "inventory_storage_date_mismatch")
        self.assertIsNone(result["storageQuantityDateGapDays"])

    def test_zero_storage_quantity_is_not_treated_as_missing(self):
        result = self.build(
            [
                storage_row("ZERO-STOCK", 2, 2, date="2026-08-09"),
                storage_row("ZERO-STOCK", 5, 0, date="2026-08-10"),
            ],
            [inventory_row("ZERO-STOCK", 0)],
        )[model.compact("ZERO-STOCK")]

        self.assertEqual(result["storageCurrentQuantity"], 0)
        self.assertEqual(result["storageInventoryCostBalanceSar"], 0)
        self.assertIsNone(result["storageUnitCostCandidateSar"])
        self.assertIsNone(result["storageUnitCostSar"])
        self.assertEqual(result["storageQuantityEvidenceStatus"], "historical_nonpositive_quantity_with_fee")
        self.assertEqual(result["storageNonpositiveQuantityFeeDays"], 1)

    def test_negative_storage_quantity_fails_closed(self):
        result = self.build(
            [storage_row("NEGATIVE-STOCK", 5, -1)],
            [inventory_row("NEGATIVE-STOCK", 1)],
        )[model.compact("NEGATIVE-STOCK")]

        self.assertEqual(result["storageCurrentQuantity"], 0)
        self.assertIsNone(result["storageUnitCostSar"])
        self.assertEqual(result["storageQuantityEvidenceStatus"], "historical_nonpositive_quantity_with_fee")
        self.assertEqual(result["storageNonpositiveQuantityFeeDays"], 1)

    def test_storage_only_path_fails_closed_without_inventory_crosscheck(self):
        result = self.build(
            [storage_row("STORAGE-ONLY", 12, 3)],
            [],
        )[model.compact("STORAGE-ONLY")]

        self.assertIsNone(result["storageAllocationQuantity"])
        self.assertIsNone(result["storageUnitCostSar"])
        self.assertEqual(result["storageUnitCostCandidateSar"], 4)
        self.assertEqual(result["storageQuantityEvidenceStatus"], "missing_inventory_crosscheck")

    def test_targeted_section_wins_when_same_or_newer(self):
        bi = {
            "generatedAt": "2026-08-10T10:00:00+08:00",
            "profit": {"marker": "full"},
        }
        same = {
            "generatedAt": "2026-08-10T10:00:00+08:00",
            "data": {"profit": {"marker": "section"}},
        }
        older = {
            "generatedAt": "2026-08-09T10:00:00+08:00",
            "data": {"profit": {"marker": "old-section"}},
        }

        self.assertTrue(model.prefer_section_payload(bi, same, "profit"))
        self.assertFalse(model.prefer_section_payload(bi, older, "profit"))
        self.assertEqual(model.extract_section(same, "profit")["marker"], "section")

    def test_inventory_date_gap_boundary(self):
        storage_date = model.parse_date("2026-08-10")
        self.assertEqual(
            model.storage_inventory_dates_are_compatible(storage_date, model.parse_date("2026-08-08")),
            (True, 2),
        )
        self.assertEqual(
            model.storage_inventory_dates_are_compatible(storage_date, model.parse_date("2026-08-07")),
            (False, 3),
        )


if __name__ == "__main__":
    unittest.main()
