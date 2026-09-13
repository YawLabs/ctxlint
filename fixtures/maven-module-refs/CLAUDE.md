# Building

```bash
./mvnw -pl core -am test
./mvnw -pl :shop-core,extras verify
./mvnw -pl com.shop:shop-web_2.13 test
./mvnw -pl cor -Dtest=CoreTest test
```

<!--
  POSITIVE CASE on the last fenced line: `cor` is not a module directory. The
  reactor is core and web, plus extras from the `extras` profile.

  Expected: one commands/maven-module-not-found error for `cor`, and NO finding
  for `core`, `:shop-core`, the profile-only `extras`, or the web module's id,
  whose artifactId ends in a property.
-->
