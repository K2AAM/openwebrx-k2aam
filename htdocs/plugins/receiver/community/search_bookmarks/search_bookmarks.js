// Seaarch Bookmarks UI plugin for OpenWebRX+ >= v1.2.118
// License: MIT
// Switching frquency code is based on LZ2DMV "frequency_far_jump" plugin
// You can reach Yannis on Telegram [@ysamouhos](https://t.me/ysamouhos) or [Github](https://github.com/ysamouhos)


Plugins.search_bookmarks.no_css = true;
Plugins.search_bookmarks._version = 0.2;
Plugins.search_bookmarks.url = '/bookmarks.json';

Plugins.search_bookmarks.init = async function () {

    if (!Plugins.isLoaded('utils', 0.4)) {
        await Plugins.load(new URL('static/plugins/receiver/community/utils/utils.js', document.baseURI).href);
        if (!Plugins.isLoaded('utils', 0.4)) {
            console.error('search_bookmarks: plugin depends on "utils >= 0.4".');
            return false;
        }
        Plugins._debug('Plugin "utils" has been loaded as dependency.');
    }

    function esc(s) {
        return String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    var remote = { data: [], failed: false };

    function fetchRemote(then) {
        var url = Plugins.search_bookmarks.url;
        if (!url || remote.failed) { if (then) then(); return; }
        fetch(url)
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(function (json) {
                remote.data = Array.isArray(json) ? json.filter(function (b) {
                    return b && b.name && b.frequency;
                }) : [];
                if (then) then();
            })
            .catch(function (err) {
                remote.failed = true;
                console.warn('search_bookmarks: no remote bookmark list at "'
                    + url + '" (' + err.message + '); '
                    + 'searching currently loaded bookmarks only.');
                if (then) then();
            });
    }

    Plugins.utils.on_ready(function () {
        var $dialog = $('#openwebrx-dialog-search-bookmarks');

        if (!$dialog.length
            || typeof bookmarks === 'undefined' || !bookmarks
            || typeof bookmarks.showSearchDialog !== 'function') {
            console.error('search_bookmarks: built-in search dialog not found; '
                + 'this plugin requires OpenWebRX+ >= v1.2.118. For older versions use "search_bookmarks_old" plugin..');
            return;
        }

        BookmarkBar.prototype.searchBookmarks = function () {
            var text = this.$search.find('#search-text').val().trim().toLowerCase();
            var seen = {};
            var all = this.getAllBookmarks().filter(function (b) {
                seen[b.name + '|' + b.frequency + '|' + (b.modulation || '')] = true;
                return true;
            });
            remote.data.forEach(function (b) {
                var key = b.name + '|' + b.frequency + '|' + (b.modulation || '');
                if (!seen[key]) { seen[key] = true; all.push(b); }
            });

            var digits = text.replace(/[.,\s]/g, '');
            var isFreq = digits.length > 0 && /^\d+$/.test(digits);

            var result = !text ? [] : all.filter(function (b) {
                return (b.name && b.name.toLowerCase().indexOf(text) >= 0)
                    || (b.description && b.description.toLowerCase().indexOf(text) >= 0)
                    || (b.modulation && b.modulation.toLowerCase().indexOf(text) >= 0)
                    || (isFreq && b.frequency && String(b.frequency).indexOf(digits) >= 0);
            });

            result.sort(function (a, b) {
                return a.name.localeCompare(b.name) || (a.frequency - b.frequency);
            });

            Plugins.search_bookmarks._results = result;

            var rows = result.map(function (b, i) {
                return '<tr' + (b.description ? ' title="' + esc(b.description) + '"' : '') + '>'
                    + '<td class="search-left">' + esc(b.name) + '</td>'
                    + '<td class="search-right">'
                    + '<a href="#" data-idx="' + i + '">'
                    + Utils.printFreq(b.frequency) + '</a>'
                    + '</td></tr>';
            }).join('\n');

            this.$search.find('#search-results').html(
                '<table class="search-results">' + rows + '</table>'
            );
        };

        var pendingTune = null;

        function tuneToBookmark(b) {
            if (!b || !b.frequency) return;
            var f = Math.round(b.frequency);

            if (Math.abs(f - center_freq) <= bandwidth / 2) {
                UI.tuneBookmark(b);
                UI.toggleScanner(false);
                return;
            }

            var key = UI.getDemodulatorPanel().getMagicKey();
            ws.send(JSON.stringify({
                "type": "setfrequency", "params": { "frequency": f, "key": key }
            }));
            UI.toggleScanner(false);

            clearInterval(pendingTune);
            var waited = 0;
            pendingTune = setInterval(function () {
                if (Math.abs(f - center_freq) <= bandwidth / 2) {
                    clearInterval(pendingTune);
                    UI.tuneBookmark(b);
                } else if ((waited += 250) >= 5000) {
                    clearInterval(pendingTune);
                    console.warn('search_bookmarks: backend did not retune to '
                        + f + ' Hz (center frequency changes may be disabled).');
                }
            }, 250);
        }

        $dialog.find('#search-results').on('click', 'a[data-idx]', function (e) {
            e.preventDefault();
            var results = Plugins.search_bookmarks._results || [];
            tuneToBookmark(results[$(this).data('idx')]);
        });

        var origShowSearchDialog = BookmarkBar.prototype.showSearchDialog;
        BookmarkBar.prototype.showSearchDialog = function (text) {
            var me = this;
            fetchRemote(function () {
                if (me.$search.is(':visible') && me.$search.find('#search-text').val()) {
                    me.searchBookmarks();
                }
            });
            return origShowSearchDialog.call(this, text);
        };

        var debounce = null;
        $dialog.find('#search-text').on('input', function () {
            clearTimeout(debounce);
            debounce = setTimeout(function () { bookmarks.searchBookmarks(); }, 200);
        });

        $('#openwebrx-panel-receiver').find('.openwebrx-bookmark-button')
            .attr('title', 'Add bookmark... (right-click to search)');

        Plugins._debug('search_bookmarks: hooked into the built-in search dialog.');
    });

    return true;
};
