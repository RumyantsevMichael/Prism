# API view

An `api` view shows the person at the design gate an HTTP or message API that the contract fixes, as an OpenAPI `3.0` or `3.1` document with `info` and `paths`, or an AsyncAPI `2` or `3` document with `info` and `channels`, written in JSON.

- When the specification is the boundary's executable contract, declare its canonical path, such as `api/reports.json`, rather than a copy.
- Otherwise put the file directly in the folder of the `slice.md` whose contract it explains.
- Declare it in that file's **Views** section with kind `api`, the clauses it explains, and its question:

  ```markdown
  - `api/reports.json` api (§1, §2): Which calls does the report API take, and what does each return?
  ```

- Keep it at 30 operations or fewer, and split a larger API into views of its resources.

```json
{
  "openapi": "3.1.0",
  "info": { "title": "Reports", "version": "1.0.0" },
  "paths": {
    "/reports/{id}": {
      "get": {
        "summary": "Download a report",
        "parameters": [{ "name": "id", "in": "path", "required": true, "schema": { "type": "string" } }],
        "responses": {
          "200": { "description": "The report bytes", "content": { "application/octet-stream": {} } },
          "404": { "description": "error: no report <id>" }
        }
      }
    }
  }
}
```
