"""
Doc Crawler for docs.frappe.io/erpnext/introduction
Extracts, structures, and caches official documentation locally for the blueprint generator.
"""
import urllib.request
import urllib.error
import re
import json
import os
import sys
from html.parser import HTMLParser

BASE_URL = "https://docs.frappe.io"
START_URL = "https://docs.frappe.io/erpnext/introduction"
OUTPUT_DIR = "/home/ankan/.gemini/antigravity/scratch/exonus-erp/docs/erpnext_blueprints/crawled_docs"
INDEX_FILE = os.path.join(OUTPUT_DIR, "index.json")

class TextExtractor(HTMLParser):
    def __init__(self):
        super().__init__()
        self.text_parts = []
        self.in_script = False
        self.in_style = False

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style'):
            self.in_script = True

    def handle_endtag(self, tag):
        if tag in ('script', 'style'):
            self.in_script = False

    def handle_data(self, data):
        if not self.in_script and not self.in_style:
            cleaned = data.strip()
            if cleaned:
                self.text_parts.append(cleaned)

    def get_text(self):
        return "\n".join(self.text_parts)

def fetch_url(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (ERPNext Documentation Inspector)'})
    try:
        with urllib.request.urlopen(req, timeout=12) as response:
            return response.read().decode('utf-8', errors='ignore')
    except Exception as e:
        return None

def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    print(f"Fetching index from {START_URL}...")
    html = fetch_url(START_URL)
    if not html:
        print("Failed to fetch start URL")
        sys.exit(1)

    # Find all links matching /erpnext/...
    raw_links = set(re.findall(r'href=\"(/erpnext/[a-zA-Z0-9_\-]+)\"', html))
    print(f"Found {len(raw_links)} unique doc pages.")

    # Prioritize Manufacturing, Stock, Accounts, Buying, Selling, Setup
    priority_keywords = [
        'manufacturing', 'bom', 'work-order', 'job-card', 'workstation', 'operation',
        'item', 'stock', 'warehouse', 'batch', 'serial', 'valuation', 'fifo',
        'buying', 'purchase', 'supplier', 'receipt',
        'selling', 'sales', 'customer', 'invoice', 'delivery',
        'accounts', 'accounting', 'journal', 'ledger', 'tax', 'gst'
    ]

    indexed_pages = []
    
    # Save list of all discovered URLs
    doc_catalog = []
    for link in sorted(raw_links):
        slug = link.replace('/erpnext/', '')
        priority = any(k in slug.lower() for k in priority_keywords)
        doc_catalog.append({
            "slug": slug,
            "url": f"{BASE_URL}{link}",
            "priority": priority
        })

    with open(INDEX_FILE, 'w') as f:
        json.dump(doc_catalog, f, indent=2)

    print(f"Catalog saved with {len(doc_catalog)} doc entries to {INDEX_FILE}")

    # Crawl top manufacturing & core modules first
    priority_list = [d for d in doc_catalog if d["priority"]]
    print(f"Downloading and parsing {len(priority_list)} priority industry doc pages...")

    downloaded = 0
    for i, doc in enumerate(priority_list):
        filename = f"{doc['slug']}.json"
        filepath = os.path.join(OUTPUT_DIR, filename)
        if os.path.exists(filepath):
            continue

        page_html = fetch_url(doc["url"])
        if not page_html:
            continue

        parser = TextExtractor()
        parser.feed(page_html)
        doc_text = parser.get_text()

        # Extract title
        title_match = re.search(r'<title>(.*?)</title>', page_html, re.IGNORECASE | re.DOTALL)
        title = title_match.group(1).strip() if title_match else doc['slug']

        doc_data = {
            "slug": doc['slug'],
            "url": doc['url'],
            "title": title,
            "text": doc_text
        }

        with open(filepath, 'w') as f:
            json.dump(doc_data, f, indent=2)

        downloaded += 1
        if downloaded % 10 == 0 or downloaded == len(priority_list):
            print(f"  Processed {downloaded}/{len(priority_list)} doc pages ({doc['slug']})")

    print(f"Doc crawl complete! {downloaded} documents extracted and indexed.")

if __name__ == '__main__':
    main()
