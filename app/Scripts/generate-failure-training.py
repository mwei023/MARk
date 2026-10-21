import json
from datetime import datetime, timedelta
from pathlib import Path

root = Path(__file__).resolve().parents[2]
out = root / 'data' / 'training' / 'failure.jsonl'
out.parent.mkdir(parents=True, exist_ok=True)

failure_types = {
    'MISSING_DEPENDENCY': [
        "Cannot find module 'pg'",
        "Error: Cannot find module ./config",
        "npm ERR! missing peer dep react@18",
        "Module not found: Can't resolve 'zod'",
        "Cannot find module 'lodash'",
        "Error: Cannot find module '@types/node'",
        "Package not found: @acme/shared-ui",
        "npm ERR! code MODULE_NOT_FOUND",
        "Module not found: Can't resolve 'axios'",
        "Error: Cannot find module ./utils/env'",
        "Cannot find module 'vitest'",
        "Missing dependency: classnames",
        "npm ERR! missing peer dependency vite@5",
        "Module not found: Can't resolve 'react-router-dom'",
        "Cannot find module 'chalk'",
    ],
    'TYPE_ERROR': [
        "error TS2322: Type string is not assignable to type number",
        "TypeError: Cannot read properties of undefined",
        "src/index.ts(12,5): error TS2554: Expected 1 arguments, but got 2",
        "Property 'status' does not exist on type 'User | undefined'",
        "error TS2345: Argument of type 'string' is not assignable to type 'number'",
        "Type 'string' is not assignable to type 'number'",
        "Cannot read properties of null (reading 'map')",
        "TypeError: items.map is not a function",
        "Error: expected string, got number",
        "Property 'userId' does not exist on type 'Session'",
        "TypeError: Cannot read properties of undefined (reading 'length')",
        "TS2339: Property 'x' does not exist on type 'Foo'",
    ],
    'LINT_FAILURE': [
        "ESLint: missing semicolon, unexpected console",
        "lint error: unused variable foo",
        "Prettier: code style issues found",
        "ERROR: 3 lint errors, 1 warning",
        "eslint no-unused-vars detected",
        "lint failed: max-lines-exceeded",
        "style guide violation: prefer const",
        "eslint: react-hooks/exhaustive-deps",
        "lint error: trailing whitespace",
        "prettier check failed",
        "lint failed: no-console",
        "eslint: promise/no-missing-await",
        "lint error: no-undef",
    ],
    'TEST_FAILURE': [
        "FAIL src/core/gateway.test.ts",
        "3 tests failed, 2 passed",
        "AssertionError: expected 2 to equal 3",
        "Vitest: 1 failed | 19 passed",
        "Test failed: should create a snapshot",
        "expect(received).toBe(expected)",
        "1 failed, 45 passed",
        "Jest: 2 failed | 104 passed",
        "AssertionError: expected 0 to match /ok/",
        "FAIL specs/runner.test.ts",
        "expected response to contain 'success'",
        "Test suite failed: integration-check",
    ],
    'BUILD_FAILURE': [
        "Build failed with exit code 1",
        "Compilation failed: 5 errors",
        "webpack compilation error: cannot resolve entry",
        "esbuild: failed to build app bundle",
        "error during build: missing generated file",
        "Build failed because of TypeScript errors",
        "Compilation failed: module not found",
        "exited with 1 errors",
        "Build step failed in CI",
        "vite build failed",
        "error during build: invalid config",
    ],
    'OOM_ERROR': [
        "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
        "Node.js v20: out of memory",
        "JavaScript heap out of memory",
        "allocation failed - process out of memory",
        "KILLED due to OOM",
        "Heap limit exceeded",
        "ENOMEM: out of memory",
        "fatal error: allocation failed - JavaScript heap out of memory",
    ],
    'NETWORK_ERROR': [
        "Error: ECONNREFUSED 127.0.0.1:5432 — connection refused",
        "fetch failed: ENOTFOUND api.example.com",
        "NetworkError: connection refused",
        "unable to connect to database host",
        "Error: fetch failed with status 502",
        "ECONNRESET: socket hang up",
        "ENOTFOUND: DNS lookup failed",
        "connection refused by upstream server",
        "API request failed: network timeout",
    ],
    'TIMEOUT': [
        "Error: Exceeded timeout of 5000ms",
        "Process timed out after 30s",
        "deadline exceeded",
        "request took too long and timed out",
        "operation timed out while waiting for response",
        "HTTP timeout after 10 seconds",
        "test exceeded the timeout",
        "request timeout after 5000ms",
        "deadline exceeded while waiting for migration",
    ],
    'PERMISSION_ERROR': [
        "Error: EACCES permission denied /usr/local/lib/node_modules",
        "Permission denied: cannot write to /var/log/app.log",
        "EPERM: operation not permitted",
        "access denied: /etc/ssl/private",
        "permission denied while creating output directory",
        "EACCES: permission denied, mkdir '/tmp/app'",
        "Permission denied on config file",
        "Operation not permitted",
    ],
}

rows = []
for label, texts in failure_types.items():
    for idx, text in enumerate(texts):
        ts = (datetime(2026, 10, 18, 9, 0, 0) + timedelta(minutes=idx)).isoformat() + 'Z'
        rows.append({
            'text': text,
            'label': label,
            'predicted': label,
            'confidence': round(0.35 + (idx % 5) * 0.12 + (0.1 if label in {'MISSING_DEPENDENCY','TYPE_ERROR','TEST_FAILURE'} else 0), 3),
            'agree': True,
            'source': 'synthetic',
            'ts': ts,
        })

with out.open('w', encoding='utf-8') as f:
    for row in rows:
        f.write(json.dumps(row, ensure_ascii=False) + '\n')

print(f'wrote {len(rows)} rows to {out}')
print(f'labels: {sorted({row["label"] for row in rows})}')
