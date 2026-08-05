"""Hidden acceptance tests for the mdtable task.

These tests are never shown to the agent. They test only behavior
that bench/tasks/mdtable/brief.md states.
"""
import pytest

from mdtable import format_table


def test_basic_normalization():
    text = "|a|bb|\n|-|-|\n|ccc|d|"
    expected = "| a   | bb  |\n| --- | --- |\n| ccc | d   |"
    assert format_table(text) == expected


def test_minimum_width_is_three():
    text = "|a|\n|-|"
    assert format_table(text) == "| a   |\n| --- |"


def test_left_alignment_marker_preserved():
    text = "|name|\n|:-|\n|x|"
    assert format_table(text) == "| name |\n| :--- |\n| x    |"


def test_right_alignment_pads_left():
    text = "|n|\n|-:|\n|42|\n|7|"
    assert format_table(text) == "|   n |\n| --: |\n|  42 |\n|   7 |"


def test_center_alignment_extra_space_goes_right():
    text = "|head|\n|:-:|\n|ab|"
    assert format_table(text) == "| head |\n| :--: |\n|  ab  |"


def test_center_alignment_even_split():
    text = "|abcd|\n|:-:|\n|ab|"
    assert format_table(text) == "| abcd |\n| :--: |\n|  ab  |"


def test_data_wider_than_header():
    text = "|h|\n|-|\n|wide cell|"
    assert format_table(text) == "| h         |\n| --------- |\n| wide cell |"


def test_cells_are_trimmed():
    text = "|  a  |  b |\n| - | - |\n"
    assert format_table(text) == "| a   | b   |\n| --- | --- |"


def test_outer_blank_lines_are_discarded():
    text = "\n  \n|a|\n|-|\n\n"
    assert format_table(text) == "| a   |\n| --- |"


def test_no_trailing_newline():
    result = format_table("|a|\n|-|")
    assert not result.endswith("\n")


def test_idempotent():
    text = "|name|value|\n|:-|--:|\n|alpha|1|\n|b|22|"
    once = format_table(text)
    assert format_table(once) == once


def test_empty_cells_allowed():
    text = "|a||\n|-|-|\n||b|"
    assert format_table(text) == "| a   |     |\n| --- | --- |\n|     | b   |"


def test_header_only_table_is_valid():
    text = "|a|b|\n|-|-|"
    assert format_table(text) == "| a   | b   |\n| --- | --- |"


def test_too_few_rows_raises():
    with pytest.raises(ValueError):
        format_table("|a|b|")


def test_mismatched_cell_count_raises():
    with pytest.raises(ValueError):
        format_table("|a|b|\n|-|-|\n|only one|")


def test_bad_alignment_cell_raises():
    with pytest.raises(ValueError):
        format_table("|a|\n|=|")


def test_alignment_cell_with_inner_colon_raises():
    with pytest.raises(ValueError):
        format_table("|a|\n|-:-|")


def test_row_without_leading_pipe_raises():
    with pytest.raises(ValueError):
        format_table("a|\n|-|")


def test_row_without_trailing_pipe_raises():
    with pytest.raises(ValueError):
        format_table("|a|\n|-")


def test_interior_blank_line_raises():
    with pytest.raises(ValueError):
        format_table("|a|\n|-|\n\n|b|")


def test_all_alignments_together():
    text = "|l|r|c|d|\n|:-|-:|:-:|-|\n|x|y|z|w|"
    header = "| l   |   r |  c  | d   |"
    align = "| :-- | --: | :-: | --- |"
    data = "| x   |   y |  z  | w   |"
    assert format_table(text) == "\n".join([header, align, data])
