# shared

This directory may later contain artefacts intentionally shared between
mock services, such as:

* contracts
* schemas
* test fixtures
* sample payloads
* development certificates
* common test data

> Scaffolding only — this directory is currently empty.

Do not add runtime coupling between services. Do not create shared
application/business logic unless there is a demonstrated need; shared
content here must remain passive artefacts (data and documents), not
code that services depend on at runtime.
