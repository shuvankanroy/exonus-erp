"""
Live Probe Harness: Manufacturing Industry Setup & Execution Lifecycle
Executes end-to-end setup and manufacturing operations on local ERPNext dev.localhost,
tracing all UI requirements, Python logic, and MariaDB state changes.
"""
import frappe
import os
import sys
import json

# Add scripts directory to path
sys.path.insert(0, '/home/ankan/.gemini/antigravity/scratch/exonus-erp/scripts')
from frappe_db_tracer import FrappeDBTracer

BLUEPRINT_DIR = "/home/ankan/.gemini/antigravity/scratch/exonus-erp/docs/erpnext_blueprints/manufacturing"
os.makedirs(BLUEPRINT_DIR, exist_ok=True)

def run_probe():
    os.chdir('/home/ankan/frappe-bench/sites')
    frappe.init(site='dev.localhost')
    frappe.connect()

    tracer = FrappeDBTracer()
    results = {}

    print("=== STEP 1: COMPANY & CHART OF ACCOUNTS SETUP ===")
    company_name = "Exonus Manufacturing Ltd"
    abbr = "EML"

    tracer.start()
    if not frappe.db.exists("Company", company_name):
        company = frappe.get_doc({
            "doctype": "Company",
            "company_name": company_name,
            "abbr": abbr,
            "default_currency": "INR",
            "country": "India",
            "create_chart_of_accounts_based_on": "Standard Template",
            "chart_of_accounts": "Standard",
            "enable_perpetual_inventory": 1
        })
        company.insert(ignore_permissions=True)
        frappe.db.commit()
        print(f"Created Company: {company_name}")
    else:
        company = frappe.get_doc("Company", company_name)
        print(f"Company {company_name} already exists.")

    diff_company = tracer.stop_and_diff()
    results["01_company_setup"] = {
        "step": "Company and Chart of Accounts Initial Creation",
        "doc": company.as_dict(),
        "db_diff": diff_company
    }

    print("\n=== STEP 2: WAREHOUSE HIERARCHY (NESTED SET) SETUP ===")
    tracer.start()
    
    # In ERPNext default company setup, Stores is created with is_group=0.
    # To have sub-warehouses (e.g. Raw Materials under Stores), Stores must be updated to is_group=1.
    stores_name = f"Stores - {abbr}"
    if frappe.db.exists("Warehouse", stores_name):
        stores_doc = frappe.get_doc("Warehouse", stores_name)
        if not stores_doc.is_group:
            stores_doc.is_group = 1
            stores_doc.save(ignore_permissions=True)
            frappe.db.commit()
            print(f"Updated {stores_name} to is_group=1")

    warehouses_to_create = [
        {"warehouse_name": "Raw Materials", "parent_warehouse": f"Stores - {abbr}", "is_group": 0},
        {"warehouse_name": "Scrap Warehouse", "parent_warehouse": f"All Warehouses - {abbr}", "is_group": 0}
    ]

    created_wh = []
    for wh_def in warehouses_to_create:
        full_name = f"{wh_def['warehouse_name']} - {abbr}"
        if not frappe.db.exists("Warehouse", full_name):
            wh = frappe.get_doc({
                "doctype": "Warehouse",
                "warehouse_name": wh_def["warehouse_name"],
                "parent_warehouse": wh_def["parent_warehouse"],
                "is_group": wh_def["is_group"],
                "company": company_name
            })
            wh.insert(ignore_permissions=True)
            frappe.db.commit()
            created_wh.append(wh.name)
            print(f"Created Warehouse: {wh.name} (lft: {wh.lft}, rgt: {wh.rgt})")

    diff_wh = tracer.stop_and_diff()
    results["02_warehouse_hierarchy"] = {
        "step": "Manufacturing Warehouse Hierarchy with Nested Set lft/rgt",
        "created_warehouses": created_wh,
        "db_diff": diff_wh
    }

    print("\n=== STEP 3: WORKSTATION & OPERATIONS SETUP ===")
    tracer.start()
    operations = ["SMT Assembly", "Wave Soldering", "Testing & QA", "Packaging"]
    for op_name in operations:
        if not frappe.db.exists("Operation", op_name):
            op = frappe.get_doc({
                "doctype": "Operation",
                "name": op_name
            })
            op.insert(ignore_permissions=True)
            frappe.db.commit()
            print(f"Created Operation: {op_name}")

    workstation_name = "Assembly Line 1"
    if not frappe.db.exists("Workstation", workstation_name):
        ws = frappe.get_doc({
            "doctype": "Workstation",
            "workstation_name": workstation_name,
            "hour_rate": 250.0,
            "hour_rate_electricity": 50.0,
            "hour_rate_consumable": 30.0,
            "hour_rate_rent": 40.0,
            "hour_rate_labour": 130.0
        })
        ws.insert(ignore_permissions=True)
        frappe.db.commit()
        print(f"Created Workstation: {workstation_name} (Total Hourly Rate: ₹250)")

    diff_ops = tracer.stop_and_diff()
    results["03_workstation_operations"] = {
        "step": "Workstations and Operations Setup",
        "db_diff": diff_ops
    }

    print("\n=== STEP 4: ITEM CATALOGUE (RAW MATERIALS & FINISHED GOODS) ===")
    tracer.start()
    items = [
        {"item_code": "PCB-MAIN-01", "item_name": "Main Circuit Board PCB", "item_group": "Raw Material", "is_stock_item": 1, "valuation_rate": 150.0, "gst_hsn_code": "85340000"},
        {"item_code": "IC-MCU-32", "item_name": "Microcontroller IC 32-bit", "item_group": "Raw Material", "is_stock_item": 1, "valuation_rate": 350.0, "gst_hsn_code": "85423100"},
        {"item_code": "CASE-ALUM-01", "item_name": "Die-cast Aluminum Enclosure", "item_group": "Raw Material", "is_stock_item": 1, "valuation_rate": 200.0, "gst_hsn_code": "76169990"},
        {"item_code": "IOT-METER-01", "item_name": "Smart Energy Meter IoT", "item_group": "Products", "is_stock_item": 1, "has_serial_no": 1, "serial_no_series": "SEM-.#####", "gst_hsn_code": "90283010"}
    ]

    for itm_def in items:
        # Ensure HSN exists
        hsn_code = itm_def["gst_hsn_code"]
        if not frappe.db.exists("GST HSN Code", hsn_code):
            hsn_doc = frappe.get_doc({
                "doctype": "GST HSN Code",
                "hsn_sac": hsn_code,
                "description": f"HSN {hsn_code}"
            })
            hsn_doc.insert(ignore_permissions=True)
            frappe.db.commit()

        if not frappe.db.exists("Item", itm_def["item_code"]):
            itm = frappe.get_doc({
                "doctype": "Item",
                "item_code": itm_def["item_code"],
                "item_name": itm_def["item_name"],
                "item_group": itm_def["item_group"],
                "is_stock_item": itm_def["is_stock_item"],
                "stock_uom": "Nos",
                "valuation_rate": itm_def.get("valuation_rate", 0.0),
                "has_serial_no": itm_def.get("has_serial_no", 0),
                "serial_no_series": itm_def.get("serial_no_series", ""),
                "gst_hsn_code": itm_def["gst_hsn_code"]
            })
            itm.insert(ignore_permissions=True)
            frappe.db.commit()
            print(f"Created Item: {itm.item_code} ({itm.item_name}) [HSN: {itm.gst_hsn_code}]")

    diff_items = tracer.stop_and_diff()
    results["04_items_catalogue"] = {
        "step": "Raw Materials and Serialized Finished Goods Catalog",
        "db_diff": diff_items
    }

    print("\n=== STEP 5: BILL OF MATERIALS (BOM) & COSTING ENGINE ===")
    tracer.start()
    fg_item = "IOT-METER-01"
    bom = frappe.get_all("BOM", filters={"item": fg_item, "is_active": 1, "is_default": 1}, fields=["name"])
    
    if not bom:
        bom_doc = frappe.get_doc({
            "doctype": "BOM",
            "item": fg_item,
            "quantity": 1,
            "with_operations": 1,
            "currency": "INR",
            "rm_cost_as_per": "Valuation Rate",
            "items": [
                {"item_code": "PCB-MAIN-01", "qty": 1, "rate": 150.0, "stock_uom": "Nos"},
                {"item_code": "IC-MCU-32", "qty": 2, "rate": 350.0, "stock_uom": "Nos"},
                {"item_code": "CASE-ALUM-01", "qty": 1, "rate": 200.0, "stock_uom": "Nos"}
            ],
            "operations": [
                {"operation": "SMT Assembly", "workstation": "Assembly Line 1", "time_in_mins": 30, "hour_rate": 250.0},
                {"operation": "Testing & QA", "workstation": "Assembly Line 1", "time_in_mins": 15, "hour_rate": 250.0}
            ]
        })
        bom_doc.insert(ignore_permissions=True)
        bom_doc.submit()
        frappe.db.commit()
        bom_name = bom_doc.name
        print(f"Created and Submitted BOM: {bom_name}")
        print(f"  Raw Material Cost: ₹{bom_doc.raw_material_cost}")
        print(f"  Operating Cost: ₹{bom_doc.operating_cost}")
        print(f"  Total Cost per Unit: ₹{bom_doc.total_cost}")
    else:
        bom_doc = frappe.get_doc("BOM", bom[0].name)
        bom_name = bom_doc.name
        print(f"BOM {bom_name} already exists. Total Cost: ₹{bom_doc.total_cost}")

    diff_bom = tracer.stop_and_diff()
    results["05_bom_engine"] = {
        "step": "Bill of Materials Calculation and Exploded Cost",
        "bom_name": bom_name,
        "raw_material_cost": float(bom_doc.raw_material_cost),
        "operating_cost": float(bom_doc.operating_cost),
        "total_cost": float(bom_doc.total_cost),
        "db_diff": diff_bom
    }

    # Save probe execution results
    probe_output_file = os.path.join(BLUEPRINT_DIR, "probe_execution_trace.json")
    with open(probe_output_file, 'w') as f:
        json.dump(results, f, indent=2, default=str)

    print(f"\nProbe execution trace successfully written to: {probe_output_file}")
    frappe.destroy()

if __name__ == '__main__':
    run_probe()
