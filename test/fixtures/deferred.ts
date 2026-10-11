export function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};

  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });

  return { promise, resolve };
}
