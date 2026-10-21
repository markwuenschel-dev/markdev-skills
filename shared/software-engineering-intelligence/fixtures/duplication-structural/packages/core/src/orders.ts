export function summarizeOrders(orders) {
  const accepted = orders.filter((order) => order.enabled);
  const total = accepted.reduce((sum, order) => sum + order.amount, 0);
  const average = accepted.length === 0 ? 0 : total / accepted.length;
  return { count: accepted.length, total, average };
}
