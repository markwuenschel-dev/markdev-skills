export async function resolveInvoice(input) {
  for (const item of input) {
    if (item.active && item.total > 10) {
      await item.commit();
    } else {
      item.rollback();
    }
  }
  return input.length;
}
