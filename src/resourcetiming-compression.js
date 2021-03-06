//
// resourcetiming-compression.js
//
// Compresses ResourceTiming data.
//
// See http://nicj.net/compressing-resourcetiming/
//
// https://github.com/nicjansma/resourcetiming-compression.js
//
(function(window) {
    "use strict";

    // save old ResourceTimingCompression object for noConflict()
    var root;
    var previousObj;
    if (typeof window !== "undefined") {
        root = window;
        previousObj = root.ResourceTimingCompression;
    }

    // model
    var ResourceTimingCompression = {};

    //
    // Functions
    //
    /**
     * Changes the value of ResourceTimingCompression back to its original value, returning
     * a reference to the ResourceTimingCompression object.
     *
     * @returns {object} Original ResourceTimingCompression object
     */
    ResourceTimingCompression.noConflict = function() {
        root.ResourceTimingCompression = previousObj;
        return ResourceTimingCompression;
    };

    /**
     * Initiator type map
     */
    ResourceTimingCompression.INITIATOR_TYPES = {
        "other": 0,
        "img": 1,
        "link": 2,
        "script": 3,
        "css": 4,
        "xmlhttprequest": 5
    };

    /**
     * Converts entries to a Trie:
     * http://en.wikipedia.org/wiki/Trie
     *
     * Assumptions:
     * 1) All entries have unique keys
     * 2) Keys cannot have "|" in their name.
     * 3) All key's values are strings
     *
     * Leaf nodes in the tree are the key's values.
     *
     * If key A is a prefix to key B, key A will be suffixed with "|"
     *
     * @param {object} entries Performance entries
     * @returns {object} A trie
     */
    ResourceTimingCompression.convertToTrie = function(entries) {
        var trie = {}, url, i, value, letters, letter, cur, node;

        for (url in entries) {
            if (!entries.hasOwnProperty(url)) {
                continue;
            }

            value = entries[url];
            letters = url.split("");
            cur = trie;

            for (i = 0; i < letters.length; i++) {
                letter = letters[i];
                node = cur[letter];

                if (typeof node === "undefined") {
                    // nothing exists yet, create either a leaf if this is the end of the word,
                    // or a branch if there are letters to go
                    cur = cur[letter] = (i === (letters.length - 1) ? value : {});
                } else if (typeof node === "string") {
                    // this is a leaf, but we need to go further, so convert it into a branch
                    cur = cur[letter] = { "|": node };
                } else {
                    if (i === (letters.length - 1)) {
                        // this is the end of our key, and we've hit an existing node.  Add our timings.
                        cur[letter]["|"] = value;
                    } else {
                        // continue onwards
                        cur = cur[letter];
                    }
                }
            }
        }

        return trie;
    };

    /**
     * Optimize the Trie by combining branches with no leaf
     *
     * @param {object} cur Current Trie branch
     * @param {boolean} top Whether or not this is the root node
     *
     * @returns {object} Optimized Trie
     */
    ResourceTimingCompression.optimizeTrie = function(cur, top) {
        var num = 0, node, ret, topNode;

        for (node in cur) {
            if (typeof cur[node] === "object") {
                // optimize children
                ret = this.optimizeTrie(cur[node], false);
                if (ret) {
                    // swap the current leaf with compressed one
                    delete cur[node];
                    node = node + ret.name;
                    cur[node] = ret.value;
                }
            }
            num++;
        }

        if (num === 1) {
            // compress single leafs
            if (top) {
                // top node gets special treatment so we're not left with a {node:,value:} at top
                topNode = {};
                topNode[node] = cur[node];
                return topNode;
            } else {
                // other nodes we return name and value separately
                return { name: node, value: cur[node] };
            }
        } else if (top) {
            // top node with more than 1 child, return it as-is
            return cur;
        } else {
            // more than two nodes and not the top, we can't compress any more
            return false;
        }
    };

    /**
     * Trims the timing, returning an offset from the startTime in ms
     *
     * @param {number} time Time
     * @param {number} startTime Start time
     *
     * @returns {number} Number of ms from start time
     */
    ResourceTimingCompression.trimTiming = function(time, startTime) {
        if (typeof time !== "number") {
            time = 0;
        }

        if (typeof startTime !== "number") {
            startTime = 0;
        }

        // strip from microseconds to milliseconds only
        var timeMs = Math.round(time),
            startTimeMs = Math.round(startTime);

        return timeMs === 0 ? 0 : (timeMs - startTimeMs);
    };

    /**
     * Attempts to get the navigationStart time for a frame.
     *
     * @param {Frame} frame IFRAME
     *
     * @returns {number} navigationStart time, or 0 if not accessible
     */
    ResourceTimingCompression.getNavStartTime = function(frame) {
        var navStart = 0;

        try {
            if (("performance" in frame) &&
            frame.performance &&
            frame.performance.timing &&
            frame.performance.timing.navigationStart) {
                navStart = frame.performance.timing.navigationStart;
            }
        } catch(e) {
            // swallow all access exceptions
        }

        return navStart;
    };

    /**
     * Gets all of the performance entries for a frame and its subframes
     *
     * @param {Frame} frame Frame
     * @param {boolean} isTopWindow This is the top window
     * @param {string} offset Offset in timing from root IFRA
     *
     * @returns {PerformanceEntry[]} Performance entries
     */
    ResourceTimingCompression.findPerformanceEntriesForFrame = function(frame, isTopWindow, offset) {
        var entries = [], i, navEntries, navStart, frameNavStart, frameOffset, navEntry, t;

        navStart = this.getNavStartTime(frame);

        // get sub-frames' entries first
        if (frame.frames) {
            for (i = 0; i < frame.frames.length; i++) {
                frameNavStart = this.getNavStartTime(frame.frames[i]);
                frameOffset = 0;
                if (frameNavStart > navStart) {
                    frameOffset = offset + (frameNavStart - navStart);
                }

                entries = entries.concat(this.findPerformanceEntriesForFrame(frame.frames[i], false, frameOffset));
            }
        }

        try {
            if (!("performance" in frame) ||
                !frame.performance ||
                !frame.performance.getEntriesByType) {
                return entries;
            }

            // add an entry for the top page
            if (isTopWindow) {
                navEntries = frame.performance.getEntriesByType("navigation");
                if (navEntries && navEntries.length === 1) {
                    navEntry = navEntries[0];

                    // replace document with the actual URL
                    entries.push({
                        name: frame.location.href,
                        startTime: 0,
                        redirectStart: navEntry.redirectStart,
                        redirectEnd: navEntry.redirectEnd,
                        fetchStart: navEntry.fetchStart,
                        domainLookupStart: navEntry.domainLookupStart,
                        domainLookupEnd: navEntry.domainLookupEnd,
                        connectStart: navEntry.connectStart,
                        secureConnectionStart: navEntry.secureConnectionStart,
                        connectEnd: navEntry.connectEnd,
                        requestStart: navEntry.requestStart,
                        responseStart: navEntry.responseStart,
                        responseEnd: navEntry.responseEnd
                    });
                } else if (frame.performance.timing) {
                    // add a fake entry from the timing object
                    t = frame.performance.timing;
                    entries.push({
                        name: frame.location.href,
                        startTime: 0,
                        redirectStart: t.redirectStart ? (t.redirectStart - t.navigationStart) : 0,
                        redirectEnd: t.redirectEnd ? (t.redirectEnd - t.navigationStart) : 0,
                        fetchStart: t.fetchStart ? (t.fetchStart - t.navigationStart) : 0,
                        domainLookupStart: t.domainLookupStart ? (t.domainLookupStart - t.navigationStart) : 0,
                        domainLookupEnd: t.domainLookupEnd ? (t.domainLookupEnd - t.navigationStart) : 0,
                        connectStart: t.connectStart ? (t.connectStart - t.navigationStart) : 0,
                        secureConnectionStart: t.secureConnectionStart ?
                            (t.secureConnectionStart - t.navigationStart) :
                            0,
                        connectEnd: t.connectEnd ? (t.connectEnd - t.navigationStart) : 0,
                        requestStart: t.requestStart ? (t.requestStart - t.navigationStart) : 0,
                        responseStart: t.responseStart ? (t.responseStart - t.navigationStart) : 0,
                        responseEnd: t.responseEnd ? (t.responseEnd - t.navigationStart) : 0
                    });
                }
            }

            // offset all of the entries by the specified offset for this frame
            var frameEntries = frame.performance.getEntriesByType("resource");
            var frameFixedEntries = [];

            for (i = 0; frameEntries && i < frameEntries.length; i++) {
                t = frameEntries[i];
                frameFixedEntries.push({
                    name: t.name,
                    initiatorType: t.initiatorType,
                    startTime: t.startTime + offset,
                    redirectStart: t.redirectStart ? (t.redirectStart + offset) : 0,
                    redirectEnd: t.redirectEnd ? (t.redirectEnd + offset) : 0,
                    fetchStart: t.fetchStart ? (t.fetchStart + offset) : 0,
                    domainLookupStart: t.domainLookupStart ? (t.domainLookupStart + offset) : 0,
                    domainLookupEnd: t.domainLookupEnd ? (t.domainLookupEnd + offset) : 0,
                    connectStart: t.connectStart ? (t.connectStart + offset) : 0,
                    secureConnectionStart: t.secureConnectionStart ? (t.secureConnectionStart + offset) : 0,
                    connectEnd: t.connectEnd ? (t.connectEnd + offset) : 0,
                    requestStart: t.requestStart ? (t.requestStart + offset) : 0,
                    responseStart: t.responseStart ? (t.responseStart + offset) : 0,
                    responseEnd: t.responseEnd ? (t.responseEnd + offset) : 0
                });
            }

            entries = entries.concat(frameFixedEntries);
        } catch(e) {
            return entries;
        }

        return entries;
    };

    /**
     * Converts a number to base-36
     *
     * @param {number} n Number
     * @returns {number|string} Base-36 number, or empty string if undefined.
     */
    ResourceTimingCompression.toBase36 = function(n) {
        return (typeof n === "number") ? n.toString(36) : "";
    };

    /**
     * Gathers performance entries and optimizes the result.
     * @returns {object} Optimized performance entries trie
     */
    ResourceTimingCompression.getResourceTiming = function() {
        /*eslint no-script-url:0*/
        var entries = this.findPerformanceEntriesForFrame(window, true, 0),
            i, e, results = {}, initiatorType, url, data;

        if (!entries || !entries.length) {
            return [];
        }

        for (i = 0; i < entries.length; i++) {
            e = entries[i];

            if (e.name.indexOf("about:") === 0 ||
               e.name.indexOf("javascript:") === 0) {
                continue;
            }

            //
            // Compress the RT data into a string:
            //
            // 1. Start with the initiator type, which is mapped to a number.
            // 2. Put the timestamps into an array in a set order (reverse chronological order),
            //    which pushes timestamps that are more likely to be zero (duration since
            //    startTime) towards the end of the array (eg redirect* and domainLookup*).
            // 3. Convert these timestamps to Base36, with empty or zero times being an empty string
            // 4. Join the array on commas
            // 5. Trim all trailing empty commas (eg ",,,")
            //

            // prefix initiatorType to the string
            initiatorType = this.INITIATOR_TYPES[e.initiatorType];
            if (typeof initiatorType === "undefined") {
                initiatorType = 0;
            }

            data = initiatorType + [
                this.trimTiming(e.startTime, 0),
                this.trimTiming(e.responseEnd, e.startTime),
                this.trimTiming(e.responseStart, e.startTime),
                this.trimTiming(e.requestStart, e.startTime),
                this.trimTiming(e.connectEnd, e.startTime),
                this.trimTiming(e.secureConnectionStart, e.startTime),
                this.trimTiming(e.connectStart, e.startTime),
                this.trimTiming(e.domainLookupEnd, e.startTime),
                this.trimTiming(e.domainLookupStart, e.startTime),
                this.trimTiming(e.redirectEnd, e.startTime),
                this.trimTiming(e.redirectStart, e.startTime)
            ].map(this.toBase36).join(",").replace(/,+$/, "");

            url = e.name;

            // if this entry already exists, add a pipe as a separator
            if (results[url] !== undefined) {
                results[url] += "|" + data;
            } else {
                results[url] = data;
            }
        }

        return this.optimizeTrie(this.convertToTrie(results), true);
    };

    //
    // Export to the appropriate location
    //
    if (typeof define === "function" && define.amd) {
        //
        // AMD / RequireJS
        //
        define([], function () {
            return ResourceTimingCompression;
        });
    } else if (typeof module !== "undefined" && module.exports) {
        //
        // Node.js
        //
        module.exports = ResourceTimingCompression;
    } else if (typeof root !== "undefined") {
        //
        // Browser Global
        //
        root.ResourceTimingCompression = ResourceTimingCompression;
    }
}(typeof window !== "undefined" ? window : undefined));
