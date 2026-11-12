// node:test runs a test's after hooks in the order they were added, so a folder that a test made before it started a server would be
// removed while the server still runs in it. Windows refuses to remove a folder that a running process works in or holds open, so
// steps given to defer run last first, like a stack: a server started in a folder stops before the folder is removed.
const stacks = new WeakMap();

export function defer(context, step) {
  let stack = stacks.get(context);
  if (!stack) {
    stack = [];
    stacks.set(context, stack);
    context.after(async () => {
      const errors = [];
      while (stack.length) {
        try { await stack.pop()(); } catch (error) { errors.push(error); }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, "Several teardown steps failed.");
    });
  }
  stack.push(step);
}
