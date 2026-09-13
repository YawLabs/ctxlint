# Building

- Server tests: `./gradlew :server:test`
- API checks: `./gradlew :server:api:check --tests "com.shop.api.ApiTest"`
- Abbreviated project names resolve: `./gradlew :ser:api:test`
- Web client: `./gradlew web-client:assemble`
- Convention plugins: `./gradlew :build-logic:check`
- Benchmarks: `./gradlew :tools:bench:run`
- Server tests, typo: `./gradlew :sever:test`

<!--
  POSITIVE CASE on the last list item: `:sever` is not a project. settings.gradle.kts
  includes server, server:api, web-client and tools:bench, and the build-logic
  included build.

  Expected: one commands/gradle-project-not-found error for `:sever`, and NO
  finding for the abbreviation `:ser:api`, the relative `web-client:assemble`,
  the included build `:build-logic`, or the conditionally included `:tools:bench`.
-->
