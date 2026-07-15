import assert from "node:assert/strict";

import { capabilitiesFor, resolveAppMode } from "../src/lib/app-mode";
import { routesFor } from "../src/lib/app-routes";
import { navigationToolsFor } from "../src/constant/navigation-tools";

assert.equal(resolveAppMode(undefined), "self-hosted");
assert.equal(resolveAppMode("anything-else"), "self-hosted");
assert.equal(resolveAppMode("public"), "public");

const publicCapabilities = capabilitiesFor("public");
assert.equal(publicCapabilities.imageGeneration, true);
assert.equal(publicCapabilities.canvas, false);
assert.equal(publicCapabilities.assets, true);
assert.equal(publicCapabilities.prompts, true);
assert.equal(publicCapabilities.videoGeneration, false);
assert.equal(publicCapabilities.audioGeneration, false);
assert.equal(publicCapabilities.textGeneration, false);
assert.equal(publicCapabilities.webdav, false);
assert.equal(publicCapabilities.agent, false);
assert.equal(publicCapabilities.channelConfig, false);
assert.equal(capabilitiesFor("self-hosted").agent, true);

const publicPaths = routesFor("public").map((route) => route.path);
assert.deepEqual(publicPaths, ["/", "/image", "/assets", "/prompts"]);
assert.equal(publicPaths.includes("/canvas"), false);
assert.equal(publicPaths.includes("/video"), false);
assert.equal(publicPaths.includes("/config"), false);
assert.equal(routesFor("self-hosted").some((route) => route.path === "/video"), true);
assert.equal(routesFor("self-hosted").some((route) => route.path === "/config"), true);

assert.deepEqual(
    navigationToolsFor("public").map((tool) => tool.slug),
    ["image", "prompts", "assets"],
);
assert.equal(navigationToolsFor("self-hosted").some((tool) => tool.slug === "config"), true);

console.log("app mode tests passed");
