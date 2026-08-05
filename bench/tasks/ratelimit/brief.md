# Product brief: token-bucket rate limiter

Build a token-bucket rate limiter as a small Python library.
Other programs will import it to throttle actions such as API calls.

## Deliverable interface

This interface is a hard contract.
Hidden acceptance tests drive your code through it, so do not rename or move any part of it.

- One file `ratelimit.py` at the repository root.
- Use the Python standard library only.
- The file exposes a class `TokenBucket`.

```python
class TokenBucket:
    def __init__(self, capacity, refill_rate, clock=time.monotonic): ...
    def try_acquire(self, tokens=1) -> bool: ...
    def available(self) -> float: ...
```

## Behavior rules

1. `capacity` is the maximum number of tokens the bucket holds.
   It must be an `int` greater than zero.
   Otherwise `__init__` raises `ValueError`.
2. `refill_rate` is the refill speed in tokens per second.
   It must be an `int` or `float` greater than zero.
   Otherwise `__init__` raises `ValueError`.
3. `clock` is a zero-argument callable that returns the current time in seconds as a number.
   The default is `time.monotonic`.
   The bucket must read time only through this callable.
4. A new bucket starts full: it holds exactly `capacity` tokens.
5. Refill is continuous and fractional.
   After `t` elapsed seconds the bucket gains `t * refill_rate` tokens, capped at `capacity`.
6. `try_acquire(tokens)` first applies the refill, then checks the balance.
   If the balance is greater than or equal to `tokens`, it subtracts `tokens` and returns `True`.
   Otherwise it returns `False` and subtracts nothing.
7. `tokens` must be an `int` greater than or equal to 1.
   Otherwise `try_acquire` raises `ValueError`.
8. A request for more tokens than `capacity` is valid input.
   It returns `False`, because it can never succeed.
9. `available()` applies the refill and returns the current balance as a number.
   It consumes nothing.
10. If the clock moves backwards, treat the elapsed time as zero.
    The balance must never decrease because of a clock step.
11. Two bucket instances share no state.

## Quality bar

- Test your code with `unittest` from the standard library.
- Cover the validation rules and the refill math with a fake clock.
