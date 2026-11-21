/**
 * Algorithm 3 — a hand-written, stable top-down merge sort.
 *
 * JavaScript's built-in Array.prototype.sort is deliberately not used here:
 * the recommendation workflow demonstrates the divide-and-conquer algorithm itself.
 */

function merge<T>(
  left: T[],
  right: T[],
  key: (item: T) => number | string,
  reverse: boolean,
): T[] {
  const merged: T[] = [];
  let leftIndex = 0;
  let rightIndex = 0;

  while (leftIndex < left.length && rightIndex < right.length) {
    const leftValue = key(left[leftIndex]);
    const rightValue = key(right[rightIndex]);
    const takeLeft = reverse
      ? leftValue >= rightValue
      : leftValue <= rightValue;
    if (takeLeft) {
      merged.push(left[leftIndex]);
      leftIndex += 1;
    } else {
      merged.push(right[rightIndex]);
      rightIndex += 1;
    }
  }

  while (leftIndex < left.length) {
    merged.push(left[leftIndex]);
    leftIndex += 1;
  }
  while (rightIndex < right.length) {
    merged.push(right[rightIndex]);
    rightIndex += 1;
  }
  return merged;
}

export function mergeSort<T>(
  items: Iterable<T>,
  key?: (item: T) => number | string,
  reverse = false,
): T[] {
  const values = Array.from(items);
  const keyFn = key ?? ((v: T) => v as unknown as number | string);

  function sort(segment: T[]): T[] {
    if (segment.length <= 1) {
      return segment;
    }
    const middle = Math.floor(segment.length / 2);
    const left = sort(segment.slice(0, middle));
    const right = sort(segment.slice(middle));
    return merge(left, right, keyFn, reverse);
  }

  return sort(values);
}

export function mergeSortByScore<T extends { score: number }>(
  items: Iterable<T>,
): T[] {
  return mergeSort(items, (item) => item.score, true);
}
