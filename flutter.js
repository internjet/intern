if (!_flutter) {
  var _flutter = {};
}
_flutter.loader = null;
(function () {
  "use strict";
  const baseUri = ensureTrailingSlash(getBaseURI());
  function getBaseURI() {
    const base = document.querySelector("base");
    return (base && base.getAttribute("href")) || "";
  }
  function ensureTrailingSlash(uri) {
    if (uri == "") {
      return uri;
    }
    return uri.endsWith("/") ? uri : `${uri}/`;
  }
  async function timeout(promise, duration, debugName) {
    if (duration < 0) {
      return promise;
    }
    let timeoutId;
    const _clock = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(
          new Error(
            `${debugName} took more than ${duration}ms to resolve. Moving on.`,
            {
              cause: timeout,
            }
          )
        );
      }, duration);
    });
    return Promise.race([promise, _clock]).finally(() => {
      clearTimeout(timeoutId);
    });
  }
  class FlutterTrustedTypesPolicy {
    constructor(validPatterns, policyName = "flutter-js") {
      const patterns = validPatterns || [
        /\.js$/,
      ];
      if (window.trustedTypes) {
        this.policy = trustedTypes.createPolicy(policyName, {
          createScriptURL: function(url) {
            const parsed = new URL(url, window.location);
            const file = parsed.pathname.split("/").pop();
            const matches = patterns.some((pattern) => pattern.test(file));
            if (matches) {
              return parsed.toString();
            }
            console.error(
              "URL rejected by TrustedTypes policy",
              policyName, ":", url, "(download prevented)");
          }
        });
      }
    }
  }
  class FlutterServiceWorkerLoader {
    setTrustedTypesPolicy(policy) {
      this._ttPolicy = policy;
    }
    loadServiceWorker(settings) {
      if (settings == null) {
        console.debug("Null serviceWorker configuration. Skipping.");
        return Promise.resolve();
      }
      if (!("serviceWorker" in navigator)) {
        let errorMessage = "Service Worker API unavailable.";
        if (!window.isSecureContext) {
          errorMessage += "\nThe current context is NOT secure."
          errorMessage += "\nRead more: https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts";
        }
        return Promise.reject(
          new Error(errorMessage)
        );
      }
      const {
        serviceWorkerVersion,
        serviceWorkerUrl = `${baseUri}flutter_service_worker.js?v=${serviceWorkerVersion}`,
        timeoutMillis = 4000,
      } = settings;
      let url = serviceWorkerUrl;
      if (this._ttPolicy != null) {
        url = this._ttPolicy.createScriptURL(url);
      }
      const serviceWorkerActivation = navigator.serviceWorker
        .register(url)
        .then((serviceWorkerRegistration) => this._getNewServiceWorker(serviceWorkerRegistration, serviceWorkerVersion))
        .then(this._waitForServiceWorkerActivation);
      return timeout(
        serviceWorkerActivation,
        timeoutMillis,
        "prepareServiceWorker"
      );
    }
    async _getNewServiceWorker(serviceWorkerRegistration, serviceWorkerVersion) {
      if (!serviceWorkerRegistration.active && (serviceWorkerRegistration.installing || serviceWorkerRegistration.waiting)) {
        console.debug("Installing/Activating first service worker.");
        return serviceWorkerRegistration.installing || serviceWorkerRegistration.waiting;
      } else if (!serviceWorkerRegistration.active.scriptURL.endsWith(serviceWorkerVersion)) {
        const newRegistration = await serviceWorkerRegistration.update();
        console.debug("Updating service worker.");
        return newRegistration.installing || newRegistration.waiting || newRegistration.active;
      } else {
        console.debug("Loading from existing service worker.");
        return serviceWorkerRegistration.active;
      }
    }
    async _waitForServiceWorkerActivation(serviceWorker) {
      if (!serviceWorker || serviceWorker.state == "activated") {
        if (!serviceWorker) {
          throw new Error("Cannot activate a null service worker!");
        } else {
          console.debug("Service worker already active.");
          return;
        }
      }
      return new Promise((resolve, _) => {
        serviceWorker.addEventListener("statechange", () => {
          if (serviceWorker.state == "activated") {
            console.debug("Activated new service worker.");
            resolve();
          }
        });
      });
    }
  }
  class FlutterEntrypointLoader {
    constructor() {
      this._scriptLoaded = false;
    }
    setTrustedTypesPolicy(policy) {
      this._ttPolicy = policy;
    async loadEntrypoint(options) {
      const { entrypointUrl = `${baseUri}main.dart.js`, onEntrypointLoaded } =
        options || {};

      return this._loadEntrypoint(entrypointUrl, onEntrypointLoaded);
    }
    didCreateEngineInitializer(engineInitializer) {
      if (typeof this._didCreateEngineInitializerResolve === "function") {
        this._didCreateEngineInitializerResolve(engineInitializer);
        // Remove the resolver after the first time, so Flutter Web can hot restart.
        this._didCreateEngineInitializerResolve = null;
        // Make the engine revert to "auto" initialization on hot restart.
        delete _flutter.loader.didCreateEngineInitializer;
      }
      if (typeof this._onEntrypointLoaded === "function") {
        this._onEntrypointLoaded(engineInitializer);
      }
    }
    _loadEntrypoint(entrypointUrl, onEntrypointLoaded) {
      const useCallback = typeof onEntrypointLoaded === "function";
      if (!this._scriptLoaded) {
        this._scriptLoaded = true;
        const scriptTag = this._createScriptTag(entrypointUrl);
        if (useCallback) {
          console.debug("Injecting <script> tag. Using callback.");
          this._onEntrypointLoaded = onEntrypointLoaded;
          document.body.append(scriptTag);
        } else {
          return new Promise((resolve, reject) => {
            console.debug(
              "Injecting <script> tag. Using Promises. Use the callback approach instead!"
            );
            this._didCreateEngineInitializerResolve = resolve;
            scriptTag.addEventListener("error", reject);
            document.body.append(scriptTag);
          });
        }
      }
    }
    _createScriptTag(url) {
      const scriptTag = document.createElement("script");
      scriptTag.type = "application/javascript";
      let trustedUrl = url;
      if (this._ttPolicy != null) {
        trustedUrl = this._ttPolicy.createScriptURL(url);
      }
      scriptTag.src = trustedUrl;
      return scriptTag;
    }
  }
  class FlutterLoader {
    async loadEntrypoint(options) {
      const { serviceWorker, ...entrypoint } = options || {};
      const flutterTT = new FlutterTrustedTypesPolicy();
      const serviceWorkerLoader = new FlutterServiceWorkerLoader();
      serviceWorkerLoader.setTrustedTypesPolicy(flutterTT.policy);
      await serviceWorkerLoader.loadServiceWorker(serviceWorker).catch(e => {
        console.warn("Exception while loading service worker:", e);
      });
      const entrypointLoader = new FlutterEntrypointLoader();
      entrypointLoader.setTrustedTypesPolicy(flutterTT.policy);
      this.didCreateEngineInitializer =
        entrypointLoader.didCreateEngineInitializer.bind(entrypointLoader);
      return entrypointLoader.loadEntrypoint(entrypoint);
    }
  }

  _flutter.loader = new FlutterLoader();
})();
