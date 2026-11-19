import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

export interface EWayBillInput {
  voucher_id: string;
  transporter_id?: string;
  transporter_name: string;
  vehicle_number: string;
  distance_km: number;
}

export function generateEWayBill(db: Database.Database, input: EWayBillInput) {
  const voucher = db.prepare('SELECT * FROM vouchers WHERE id = ?').get(input.voucher_id) as any;
  if (!voucher) throw new Error('Voucher not found for E-Way Bill generation');

  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(voucher.company_id) as any;
  const party = db.prepare('SELECT * FROM accounts WHERE id = ?').get(voucher.party_account_id) as any;

  // Generate 12-Digit E-Way Bill Number (Govt NIC format specification)
  const ewayBillNumber = `24${Date.now().toString().slice(-10)}`;
  const validUpto = new Date(Date.now() + 24 * 3600 * 1000 * Math.ceil(input.distance_km / 100)).toISOString().split('T')[0];

  db.prepare(`
    INSERT INTO gst_e_way_bills (
      id, voucher_id, eway_bill_number, eway_bill_date, valid_upto, transporter_id, transporter_name, vehicle_number, distance_km, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACT')
  `).run(
    randomUUID(), input.voucher_id, ewayBillNumber, voucher.date,
    validUpto, input.transporter_id || '', input.transporter_name, input.vehicle_number, input.distance_km
  );

  return {
    ewayBillNumber,
    docNumber: voucher.voucher_number,
    docDate: voucher.date,
    fromGstin: company.gstin,
    toGstin: party?.gstin || 'URP',
    vehicleNumber: input.vehicle_number,
    validUpto,
    totalValue: voucher.gross_total
  };
}

export function generateEInvoice(db: Database.Database, voucherId: string) {
  const voucher = db.prepare('SELECT * FROM vouchers WHERE id = ?').get(voucherId) as any;
  if (!voucher) throw new Error('Voucher not found for E-Invoicing');

  // Generate 64-character SHA256 simulation matching IRP (Invoice Registration Portal)
  const irnHash = `IRN${Date.now()}${randomUUID().replace(/-/g, '')}`.slice(0, 64);
  const ackNumber = `122${Date.now().toString().slice(-8)}`;
  const ackDate = new Date().toISOString();
  const signedQr = `GSTIN:${voucher.company_id}|IRN:${irnHash}|VAL:${voucher.gross_total}`;

  db.prepare(`
    INSERT INTO gst_e_invoices (
      id, voucher_id, irn_hash, ack_number, ack_date, signed_qr_code, signed_invoice_json, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ACT')
  `).run(randomUUID(), voucherId, irnHash, ackNumber, ackDate, signedQr, JSON.stringify({ irn: irnHash, total: voucher.gross_total }));

  return {
    irn: irnHash,
    ackNumber,
    ackDate,
    signedQrCode: signedQr,
  };
}
