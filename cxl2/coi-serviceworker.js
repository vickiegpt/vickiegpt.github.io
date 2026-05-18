/*! coi-serviceworker v0.1.6 - Guido Zuidhof, licensed under MIT */
let coepCredentialless = false;
if (typeof window === 'undefined') {
    self.addEventListener("install", () => self.skipWaiting());
    self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

    self.addEventListener("message", (ev) => {
        if (!ev.data) {
            return;
        } else if (ev.data.type === "deregister") {
            self.registration
                .unregister()
                .then(() => {
                    return self.clients.matchAll();
                })
                .then(clients => {
                    clients.forEach((client) => client.navigate(client.url));
                });
        } else if (ev.data.type === "coepCredentialless") {
            coepCredentialless = ev.data.value;
        }
    });

    self.addEventListener("fetch", function (event) {
        const r = event.request;
        if (r.cache === "only-if-cached" && r.mode !== "same-origin") {
            return;
        }

        let request = (coepCredentialless && r.mode === "no-cors")
            ? new Request(r, {
                credentials: "omit",
            })
            : r;
        const url = new URL(request.url);
        if (url.origin === self.location.origin &&
            url.pathname === "/cxl2/images/alpine-x86_64/qemu-system-x86_64") {
            const compatUrl = new URL("/cxl2/images/alpine-x86_64/qemu-system-x86_64.js", self.location.origin);
            compatUrl.searchParams.set("v", "20260518-worker-import2");
            request = new Request(compatUrl.href, { cache: "reload", credentials: request.credentials });
        } else if (url.origin === self.location.origin &&
            url.pathname === "/cxl2/images/alpine-x86_64/qemu-system-x86_64.worker.js" &&
            !url.search) {
            const compatUrl = new URL("/cxl2/images/alpine-x86_64/qemu-system-x86_64.worker.js", self.location.origin);
            compatUrl.searchParams.set("v", "20260518-worker-import2");
            request = new Request(compatUrl.href, { cache: "reload", credentials: request.credentials });
        }
        event.respondWith(
            fetch(request)
                .then((response) => {
                    if (response.status === 0) {
                        return response;
                    }

                    const newHeaders = new Headers(response.headers);
                    newHeaders.set("Cross-Origin-Embedder-Policy",
                        coepCredentialless ? "credentialless" : "require-corp"
                    );
                    newHeaders.set("Cross-Origin-Opener-Policy", "same-origin");

                    /* Null-body statuses (101 / 204 / 205 / 304) cannot
                     * carry a body — Response() throws if we pass one. */
                    const nullBodyStatus = response.status === 101 ||
                        response.status === 204 || response.status === 205 ||
                        response.status === 304;
                    return new Response(nullBodyStatus ? null : response.body, {
                        status: response.status,
                        statusText: response.statusText,
                        headers: newHeaders,
                    });
                })
                .catch((e) => console.error(e))
        );
    });

} else {
    (() => {
        // You can customize the behavior of this script through a global `coi` variable.
        const coi = {
            shouldRegister: () => true,
            shouldDeregister: () => false,
            coepCredentialless: () => false,
            doReload: () => window.location.reload(),
            quiet: false,
            ...window.coi
        };

        const n = navigator;
        const currentScriptUrl = window.document.currentScript && window.document.currentScript.src;

        if (n.serviceWorker && n.serviceWorker.controller) {
            n.serviceWorker.controller.postMessage({
                type: "coepCredentialless",
                value: coi.coepCredentialless(),
            });

            if (coi.shouldDeregister()) {
                n.serviceWorker.controller.postMessage({ type: "deregister" });
            }

            if (currentScriptUrl && n.serviceWorker.controller.scriptURL !== currentScriptUrl) {
                n.serviceWorker.register(currentScriptUrl).then(
                    (registration) => {
                        registration.update && registration.update();
                        setTimeout(() => coi.doReload(), 250);
                    },
                    (err) => {
                        !coi.quiet && console.error("COOP/COEP Service Worker update failed:", err);
                    }
                );
                return;
            }
        }

        // If we're already coi: do nothing. Perhaps it's due to this script doing its job, or COOP/COEP are
        // already set from the origin server. Also if the browser has no notion of crossOriginIsolated, just give up here.
        if (window.crossOriginIsolated !== false || !coi.shouldRegister()) return;

        if (!window.isSecureContext) {
            !coi.quiet && console.log("COOP/COEP Service Worker not registered, a secure context is required.");
            return;
        }

        // In some environments (e.g. Chrome incognito mode) this won't be available
        if (n.serviceWorker) {
            n.serviceWorker.register(window.document.currentScript.src).then(
                (registration) => {
                    !coi.quiet && console.log("COOP/COEP Service Worker registered", registration.scope);

                    registration.addEventListener("updatefound", () => {
                        !coi.quiet && console.log("Reloading page to make use of updated COOP/COEP Service Worker.");
                        coi.doReload();
                    });

                    // If the registration is active, but it's not controlling the page
                    if (registration.active && !n.serviceWorker.controller) {
                        !coi.quiet && console.log("Reloading page to make use of COOP/COEP Service Worker.");
                        coi.doReload();
                    }
                },
                (err) => {
                    !coi.quiet && console.error("COOP/COEP Service Worker failed to register:", err);
                }
            );
        }
    })();
}
