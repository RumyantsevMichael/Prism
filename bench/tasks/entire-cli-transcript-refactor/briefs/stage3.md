# Support unbounded transcript records

A customer transcript contains a valid JSONL record larger than the old scanner limit.
The shared file parser must support this record without a fixed maximum size.
Finish the parser test move and remove obsolete parser artifacts.

Ask the product owner about memory behavior, size limits, offsets, and final test ownership before implementation.
