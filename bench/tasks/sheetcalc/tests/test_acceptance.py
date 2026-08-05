"""Hidden acceptance tests for the sheetcalc task.

These tests are never shown to the agent. They test only behavior
that bench/tasks/sheetcalc/brief.md states.
"""
import pytest

from sheetcalc import Spreadsheet


@pytest.fixture
def sheet():
    return Spreadsheet()


def test_empty_cell_is_none(sheet):
    assert sheet.get("A1") is None


def test_number_literal(sheet):
    sheet.set("A1", "3")
    assert sheet.get("A1") == pytest.approx(3.0)
    assert isinstance(sheet.get("A1"), float)


def test_decimal_literal(sheet):
    sheet.set("A1", "3.5")
    assert sheet.get("A1") == pytest.approx(3.5)


def test_text_literal(sheet):
    sheet.set("A1", "hello world")
    assert sheet.get("A1") == "hello world"


def test_raw_returns_original(sheet):
    sheet.set("A1", "=B1+1")
    assert sheet.raw("A1") == "=B1+1"


def test_raw_of_empty_cell_is_none(sheet):
    assert sheet.raw("Q30") is None


def test_constant_formula(sheet):
    sheet.set("A1", "=2+3")
    assert sheet.get("A1") == pytest.approx(5.0)


def test_operator_precedence(sheet):
    sheet.set("A1", "=2+3*4")
    assert sheet.get("A1") == pytest.approx(14.0)


def test_parentheses(sheet):
    sheet.set("A1", "=(2+3)*4")
    assert sheet.get("A1") == pytest.approx(20.0)


def test_left_associative_subtraction(sheet):
    sheet.set("A1", "=10-4-3")
    assert sheet.get("A1") == pytest.approx(3.0)


def test_unary_minus(sheet):
    sheet.set("A1", "=-3+1")
    assert sheet.get("A1") == pytest.approx(-2.0)


def test_division(sheet):
    sheet.set("A1", "=10/4")
    assert sheet.get("A1") == pytest.approx(2.5)


def test_decimal_in_formula(sheet):
    sheet.set("A1", "=1.5*2")
    assert sheet.get("A1") == pytest.approx(3.0)


def test_whitespace_in_formula(sheet):
    sheet.set("A1", "=  1 +  2 ")
    assert sheet.get("A1") == pytest.approx(3.0)


def test_simple_reference(sheet):
    sheet.set("A1", "2")
    sheet.set("B1", "=A1*10")
    assert sheet.get("B1") == pytest.approx(20.0)


def test_chain_recalculates_on_set(sheet):
    sheet.set("A1", "2")
    sheet.set("B1", "=A1+1")
    sheet.set("C1", "=B1+1")
    assert sheet.get("C1") == pytest.approx(4.0)
    sheet.set("A1", "10")
    assert sheet.get("C1") == pytest.approx(12.0)


def test_empty_reference_counts_as_zero(sheet):
    sheet.set("A1", "=Z99+5")
    assert sheet.get("A1") == pytest.approx(5.0)


def test_text_in_arithmetic_is_error(sheet):
    sheet.set("A1", "abc")
    sheet.set("B1", "=A1+1")
    assert sheet.get("B1") == "#ERROR!"


def test_division_by_zero(sheet):
    sheet.set("A1", "=1/0")
    assert sheet.get("A1") == "#DIV/0!"


def test_error_propagates_through_reference(sheet):
    sheet.set("A1", "=1/0")
    sheet.set("B1", "=A1+1")
    assert sheet.get("B1") == "#DIV/0!"


@pytest.mark.parametrize("formula", ["=2+*3", "=(1+2", "=SUM(A1)", "=A1:B2+1"])
def test_bad_formula_is_error(sheet, formula):
    sheet.set("C5", formula)
    assert sheet.get("C5") == "#ERROR!"


def test_self_reference_is_cycle(sheet):
    sheet.set("A1", "=A1")
    assert sheet.get("A1") == "#CYCLE!"


def test_mutual_cycle(sheet):
    sheet.set("A1", "=B1")
    sheet.set("B1", "=A1")
    assert sheet.get("A1") == "#CYCLE!"
    assert sheet.get("B1") == "#CYCLE!"


def test_cell_depending_on_cycle_is_cycle(sheet):
    sheet.set("A1", "=B1")
    sheet.set("B1", "=A1")
    sheet.set("C1", "=A1+1")
    assert sheet.get("C1") == "#CYCLE!"


def test_breaking_cycle_recovers(sheet):
    sheet.set("A1", "=B1")
    sheet.set("B1", "=A1")
    assert sheet.get("A1") == "#CYCLE!"
    sheet.set("B1", "2")
    assert sheet.get("A1") == pytest.approx(2.0)
    assert sheet.get("B1") == pytest.approx(2.0)


def test_delete_empties_and_recalculates(sheet):
    sheet.set("A1", "5")
    sheet.set("B1", "=A1+1")
    assert sheet.get("B1") == pytest.approx(6.0)
    sheet.delete("A1")
    assert sheet.get("A1") is None
    assert sheet.raw("A1") is None
    assert sheet.get("B1") == pytest.approx(1.0)


def test_delete_empty_cell_is_allowed(sheet):
    sheet.delete("A1")
    assert sheet.get("A1") is None


def test_sum_column(sheet):
    sheet.set("A1", "1")
    sheet.set("A2", "2")
    sheet.set("A3", "3")
    sheet.set("B1", "=SUM(A1:A3)")
    assert sheet.get("B1") == pytest.approx(6.0)


def test_sum_rectangle(sheet):
    sheet.set("A1", "1")
    sheet.set("B1", "2")
    sheet.set("A2", "3")
    sheet.set("B2", "4")
    sheet.set("C1", "=SUM(A1:B2)")
    assert sheet.get("C1") == pytest.approx(10.0)


def test_sum_skips_text_and_empty(sheet):
    sheet.set("A1", "1")
    sheet.set("A2", "note")
    sheet.set("A4", "3")
    sheet.set("B1", "=SUM(A1:A4)")
    assert sheet.get("B1") == pytest.approx(4.0)


def test_sum_of_empty_range_is_zero(sheet):
    sheet.set("B1", "=SUM(D1:E5)")
    assert sheet.get("B1") == pytest.approx(0.0)


def test_sum_propagates_error_in_range(sheet):
    sheet.set("A1", "1")
    sheet.set("A2", "=1/0")
    sheet.set("B1", "=SUM(A1:A2)")
    assert sheet.get("B1") == "#DIV/0!"


def test_min_and_max(sheet):
    sheet.set("A1", "5")
    sheet.set("A2", "-2")
    sheet.set("A3", "3")
    sheet.set("B1", "=MIN(A1:A3)")
    sheet.set("B2", "=MAX(A1:A3)")
    assert sheet.get("B1") == pytest.approx(-2.0)
    assert sheet.get("B2") == pytest.approx(5.0)


def test_min_of_no_numbers_is_error(sheet):
    sheet.set("A1", "text")
    sheet.set("B1", "=MIN(A1:A2)")
    assert sheet.get("B1") == "#ERROR!"


def test_function_name_case_insensitive(sheet):
    sheet.set("A1", "2")
    sheet.set("A2", "3")
    sheet.set("B1", "=sum(A1:A2)")
    assert sheet.get("B1") == pytest.approx(5.0)


def test_reference_case_insensitive(sheet):
    sheet.set("a1", "5")
    assert sheet.get("A1") == pytest.approx(5.0)
    sheet.set("B1", "=a1+1")
    assert sheet.get("B1") == pytest.approx(6.0)


def test_range_corners_any_order(sheet):
    sheet.set("A1", "1")
    sheet.set("B2", "2")
    sheet.set("C1", "=SUM(B2:A1)")
    assert sheet.get("C1") == pytest.approx(3.0)


@pytest.mark.parametrize("address", ["A0", "1A", "", "A1B", "A 1", "A01"])
def test_invalid_address_raises(sheet, address):
    with pytest.raises(ValueError):
        sheet.set(address, "1")
    with pytest.raises(ValueError):
        sheet.get(address)


def test_non_string_raw_raises(sheet):
    with pytest.raises(ValueError):
        sheet.set("A1", 5)


def test_multi_letter_column(sheet):
    sheet.set("AA10", "7")
    sheet.set("B1", "=AA10*2")
    assert sheet.get("B1") == pytest.approx(14.0)


def test_deep_chain(sheet):
    sheet.set("A1", "1")
    for row in range(2, 51):
        sheet.set(f"A{row}", f"=A{row - 1}+1")
    assert sheet.get("A50") == pytest.approx(50.0)
    sheet.set("A1", "100")
    assert sheet.get("A50") == pytest.approx(149.0)


def test_diamond_dependency(sheet):
    sheet.set("A1", "1")
    sheet.set("B1", "=A1+1")
    sheet.set("C1", "=A1+2")
    sheet.set("D1", "=B1+C1")
    assert sheet.get("D1") == pytest.approx(5.0)
    sheet.set("A1", "10")
    assert sheet.get("D1") == pytest.approx(23.0)


def test_overwrite_formula_with_literal(sheet):
    sheet.set("A1", "1")
    sheet.set("B1", "=A1+1")
    sheet.set("C1", "=B1*2")
    assert sheet.get("C1") == pytest.approx(4.0)
    sheet.set("B1", "7")
    assert sheet.get("C1") == pytest.approx(14.0)
