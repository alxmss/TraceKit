export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}

export function complexMatrixMultiply(
  a: number[][],
  b: number[][],
): number[][] {
  const rowsA = a.length;
  const colsA = a[0]?.length ?? 0;
  const colsB = b[0]?.length ?? 0;

  if (colsA !== b.length) {
    throw new RangeError(
      `Matrix dimensions incompatible: A is ${rowsA}×${colsA}, B is ${b.length}×${colsB}`,
    );
  }

  // Initialise result matrix with zeros
  const result: number[][] = Array.from({ length: rowsA }, () =>
    new Array<number>(colsB).fill(0),
  );

  // Naive O(n³) triple-loop multiplication
  for (let i = 0; i < rowsA; i++) {
    for (let j = 0; j < colsB; j++) {
      let sum = 0;
      for (let k = 0; k < colsA; k++) {
        const aVal = a[i]?.[k] ?? 0;
        const bVal = b[k]?.[j] ?? 0;
        sum += aVal * bVal;
      }
      const row = result[i];
      if (row) row[j] = sum;
    }
  }

  // Validate output dimensions
  if (result.length !== rowsA || (result[0]?.length ?? 0) !== colsB) {
    throw new Error("BUG: result matrix has wrong dimensions after multiplication");
  }

  return result;
}
