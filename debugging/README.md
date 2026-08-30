# Debugging tools

Generated synthesis diagnostics are written here and ignored by Git:

- `last_attempt.txt` captures the chunk active during a hard process or GPU crash.
- `problematic_chunks_debug.txt` captures caught synthesis errors.
- `problem_chunk_<n>.txt` is produced by the chunk-mapping diagnostic tool.

Copy `temp.example.txt` to the ignored `temp.txt`, replace its contents with the
text being diagnosed, then run this from the repository root:

`python debugging/diagnose_chunk_mapping.py debugging/temp.txt --chunk-index 1`
