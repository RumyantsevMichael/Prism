"""Hidden acceptance tests for the ratelimit task.

These tests are never shown to the agent. They test only behavior
that bench/tasks/ratelimit/brief.md states.
"""
import pytest

import ratelimit


class FakeClock:
    def __init__(self, t=0.0):
        self.t = float(t)

    def advance(self, dt):
        self.t += dt

    def __call__(self):
        return self.t


def make(capacity=10, rate=1.0, t0=0.0):
    clock = FakeClock(t0)
    bucket = ratelimit.TokenBucket(capacity, rate, clock=clock)
    return bucket, clock


def test_starts_full():
    bucket, _ = make(capacity=5)
    assert bucket.available() == pytest.approx(5)


def test_acquire_success_deducts():
    bucket, _ = make(capacity=5)
    assert bucket.try_acquire(3) is True
    assert bucket.available() == pytest.approx(2)


def test_acquire_denied_when_insufficient():
    bucket, _ = make(capacity=2)
    assert bucket.try_acquire(3) is False
    assert bucket.available() == pytest.approx(2)


def test_acquire_exactly_available():
    bucket, _ = make(capacity=4)
    assert bucket.try_acquire(4) is True
    assert bucket.available() == pytest.approx(0)


def test_default_tokens_is_one():
    bucket, _ = make(capacity=2)
    assert bucket.try_acquire() is True
    assert bucket.available() == pytest.approx(1)


def test_refill_over_time():
    bucket, clock = make(capacity=10, rate=2.0)
    assert bucket.try_acquire(10) is True
    clock.advance(2.5)
    assert bucket.available() == pytest.approx(5)


def test_refill_capped_at_capacity():
    bucket, clock = make(capacity=10, rate=2.0)
    assert bucket.try_acquire(10) is True
    clock.advance(100)
    assert bucket.available() == pytest.approx(10)


def test_fractional_refill_accumulates():
    bucket, clock = make(capacity=5, rate=0.5)
    assert bucket.try_acquire(5) is True
    clock.advance(1)
    assert bucket.try_acquire(1) is False
    clock.advance(1)
    assert bucket.try_acquire(1) is True


def test_failed_acquire_consumes_nothing():
    bucket, clock = make(capacity=5, rate=1.0)
    assert bucket.try_acquire(5) is True
    clock.advance(0.5)
    assert bucket.try_acquire(1) is False
    assert bucket.available() == pytest.approx(0.5)


def test_request_above_capacity_returns_false():
    bucket, _ = make(capacity=3)
    assert bucket.try_acquire(4) is False
    assert bucket.available() == pytest.approx(3)


@pytest.mark.parametrize("capacity", [0, -1, 1.5, "3"])
def test_invalid_capacity_raises(capacity):
    with pytest.raises(ValueError):
        ratelimit.TokenBucket(capacity, 1.0, clock=FakeClock())


@pytest.mark.parametrize("rate", [0, -3, "1"])
def test_invalid_rate_raises(rate):
    with pytest.raises(ValueError):
        ratelimit.TokenBucket(1, rate, clock=FakeClock())


@pytest.mark.parametrize("tokens", [0, -1, 1.5])
def test_invalid_tokens_raises(tokens):
    bucket, _ = make()
    with pytest.raises(ValueError):
        bucket.try_acquire(tokens)


def test_clock_backwards_does_not_drain():
    bucket, clock = make(capacity=10, rate=1.0)
    assert bucket.try_acquire(5) is True
    before = bucket.available()
    clock.advance(-100)
    assert bucket.available() >= before - 1e-9


def test_no_refill_without_elapsed_time():
    bucket, _ = make(capacity=10, rate=5.0)
    assert bucket.try_acquire(4) is True
    assert bucket.available() == pytest.approx(6)
    assert bucket.available() == pytest.approx(6)


def test_available_does_not_consume():
    bucket, clock = make(capacity=10, rate=1.0)
    assert bucket.try_acquire(10) is True
    clock.advance(3)
    assert bucket.available() == pytest.approx(3)
    assert bucket.available() == pytest.approx(3)
    assert bucket.try_acquire(3) is True


def test_instances_are_independent():
    clock = FakeClock()
    a = ratelimit.TokenBucket(5, 1.0, clock=clock)
    b = ratelimit.TokenBucket(5, 1.0, clock=clock)
    assert a.try_acquire(5) is True
    assert b.available() == pytest.approx(5)


def test_integer_rate_accepted():
    clock = FakeClock()
    bucket = ratelimit.TokenBucket(2, 4, clock=clock)
    assert bucket.try_acquire(2) is True
    clock.advance(0.25)
    assert bucket.try_acquire(1) is True
