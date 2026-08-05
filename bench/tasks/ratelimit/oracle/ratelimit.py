"""Reference solution for the ratelimit task. Never shown to the agent."""
import time


class TokenBucket:
    def __init__(self, capacity, refill_rate, clock=time.monotonic):
        if type(capacity) is not int or capacity <= 0:
            raise ValueError("capacity must be an int greater than zero")
        if type(refill_rate) not in (int, float) or refill_rate <= 0:
            raise ValueError("refill_rate must be a number greater than zero")
        self._capacity = capacity
        self._rate = float(refill_rate)
        self._clock = clock
        self._balance = float(capacity)
        self._last = clock()

    def _refill(self):
        now = self._clock()
        elapsed = now - self._last
        if elapsed > 0:
            self._balance = min(self._capacity, self._balance + elapsed * self._rate)
        self._last = now

    def try_acquire(self, tokens=1):
        if type(tokens) is not int or tokens < 1:
            raise ValueError("tokens must be an int greater than or equal to 1")
        self._refill()
        if self._balance >= tokens:
            self._balance -= tokens
            return True
        return False

    def available(self):
        self._refill()
        return self._balance
