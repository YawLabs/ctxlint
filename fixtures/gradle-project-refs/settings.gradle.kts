rootProject.name = "shop"

pluginManagement {
    includeBuild("build-logic")
    repositories {
        gradlePluginPortal()
    }
}

plugins {
    id("com.gradle.develocity") version "4.0"
}

include("server")
include("server:api")
include("web-client")

if (System.getenv("CI") == null) {
    include("tools:bench")
}
