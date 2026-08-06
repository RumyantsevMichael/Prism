# Unbounded record requirements

Support a valid record larger than 10 MiB.
Do not set a fixed maximum record size.
Stream the file and grow only the current record buffer.
Do not read the complete file into memory.
Support a large record after a nonzero physical line offset.
Keep file parser tests in the shared transcript package.
Keep unrelated tests in their existing packages.
Remove unused imports, constants, helpers, and dead parser artifacts.
