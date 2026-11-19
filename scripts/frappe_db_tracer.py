"""
Frappe DB Snapshot & Mutation Tracer
Captures exact database state changes before and after transactions.
"""
import frappe
import json

class FrappeDBTracer:
    def __init__(self, target_tables=None):
        self.target_tables = target_tables or [
            "tabCompany", "tabAccount", "tabWarehouse", "tabItem",
            "tabBOM", "tabBOM Item", "tabBOM Operation",
            "tabWork Order", "tabJob Card", "tabStock Entry",
            "tabStock Ledger Entry", "tabBin", "tabGL Entry",
            "tabPurchase Receipt", "tabSales Invoice"
        ]
        self.before_snapshot = {}
        self.after_snapshot = {}

    def capture_snapshot(self):
        snapshot = {}
        for table in self.target_tables:
            try:
                # Get all records with key identifying columns
                records = frappe.db.sql(f"SELECT * FROM `{table}`", as_dict=True)
                snapshot[table] = {r.get('name', str(i)): r for i, r in enumerate(records)}
            except Exception:
                continue
        return snapshot

    def start(self):
        self.before_snapshot = self.capture_snapshot()

    def stop_and_diff(self):
        self.after_snapshot = self.capture_snapshot()
        diff = {
            "inserted": {},
            "updated": {},
            "deleted": {}
        }

        for table, after_records in self.after_snapshot.items():
            before_records = self.before_snapshot.get(table, {})
            
            # Check inserted
            for rec_id, rec_data in after_records.items():
                if rec_id not in before_records:
                    if table not in diff["inserted"]:
                        diff["inserted"][table] = []
                    diff["inserted"][table].append(rec_data)
                else:
                    # Check updated fields
                    b_data = before_records[rec_id]
                    changes = {}
                    for field, val in rec_data.items():
                        if field in ['modified', 'creation', '_liked_by', '_user_tags']:
                            continue
                        if b_data.get(field) != val:
                            changes[field] = {"old": b_data.get(field), "new": val}
                    if changes:
                        if table not in diff["updated"]:
                            diff["updated"][table] = []
                        diff["updated"][table].append({"name": rec_id, "changes": changes})

            # Check deleted
            for rec_id, b_data in before_records.items():
                if rec_id not in after_records:
                    if table not in diff["deleted"]:
                        diff["deleted"][table] = []
                    diff["deleted"][table].append(rec_id)

        return diff
