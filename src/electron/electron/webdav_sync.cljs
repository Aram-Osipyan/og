(ns electron.webdav-sync
  "Syncs each open graph's git repository with a WebDAV folder.
   The transport and merge logic live in webdav_sync.js."
  (:require ["/electron/webdav_sync" :refer [WebDAVClient WebDAVGitSync]]
            ["dugite" :refer [exec]]
            ["path" :as node-path]
            [clojure.string :as string]
            [electron.git :as git]
            [electron.logger :as logger]
            [electron.state :as state]
            [electron.utils :as utils]
            [promesa.core :as p]))

(def log-error (partial logger/error "[WebDAV]"))

(defn- cfg [k] (get-in @state/state [:config k]))

(defn enabled?
  []
  (and (true? (cfg :webdav/enabled?))
       (not (string/blank? (cfg :webdav/url)))))

(defn- sync-seconds
  []
  (let [s (cfg :webdav/sync-seconds)]
    (if (and (int? s) (pos? s)) s 300)))

(defn- run-git
  [args ^js opts]
  (exec args (.-cwd opts) (if-let [input (.-input opts)] #js {:stdin input} #js {})))

(defn- graph-remote-url
  "Each graph gets its own folder under the configured URL, named after the graph folder."
  [graph-path]
  (str (string/replace (cfg :webdav/url) #"/+$" "") "/" (js/encodeURIComponent (.basename node-path graph-path))))

(defn- ->syncer
  [graph-path]
  (let [client (WebDAVClient. #js {:url (graph-remote-url graph-path)
                                   :username (cfg :webdav/username)
                                   :password (cfg :webdav/password)})]
    (WebDAVGitSync. #js {:git run-git
                         :dir graph-path
                         :client client
                         :log #(logger/info "[WebDAV]" %)})))

(defonce ^:private *running (atom #{}))

(defn sync-graph!
  "Commits local edits, then pulls, merges and pushes. Skips a graph that is already syncing."
  [graph-path & {:keys [notify?]}]
  (when (and graph-path (enabled?) (not (contains? @*running graph-path)))
    (swap! *running conj graph-path)
    (-> (p/let [_ (git/add-all-and-commit-single-graph! graph-path "Auto saved by Logseq")
                ^js result (.sync (->syncer graph-path))
                status (.-status result)]
          (logger/info "[WebDAV]" graph-path status)
          (when notify?
            (utils/send-to-renderer "notification"
                                    {:type "success"
                                     :payload (str "WebDAV sync: " status)}))
          status)
        (p/catch (fn [e]
                   (log-error graph-path e)
                   (utils/send-to-renderer "notification"
                                           {:type "error"
                                            :payload (str "WebDAV sync failed: " (or (.-message e) e))})
                   nil))
        (p/finally #(swap! *running disj graph-path)))))

(defn sync-all!
  []
  (doseq [path (state/get-all-graph-paths)]
    (sync-graph! path)))

(defonce ^:private *interval (atom nil))

(defn configure!
  "(Re)starts the periodic sync from the current config. Safe to call repeatedly."
  []
  (when @*interval
    (swap! *interval js/clearInterval))
  (when (enabled?)
    (logger/info ::configure (sync-seconds))
    (js/setTimeout sync-all! 3000)
    (reset! *interval (js/setInterval sync-all! (* 1000 (sync-seconds))))))

(defn before-graph-close-hook!
  []
  (when (enabled?)
    (sync-all!)))
