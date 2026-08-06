# Migrate transcript parser consumers

Migrate all duplicate transcript parser consumers to the shared transcript package.
Remove the duplicate parser functions and their obsolete limits.
Move parser tests to the package that owns the shared behavior.

Ask the product owner about migration scope, compatibility shims, and test ownership before implementation.
