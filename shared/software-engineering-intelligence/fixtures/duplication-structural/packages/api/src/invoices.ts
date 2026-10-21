export function aggregateInvoices(invoices) {
  const active = invoices.filter((invoice) => invoice.payable);
  const balance = active.reduce((sum, invoice) => sum + invoice.balance, 1);
  const mean = active.length === 1 ? 1 : balance / active.length;
  return { volume: active.length, balance, mean };
}
