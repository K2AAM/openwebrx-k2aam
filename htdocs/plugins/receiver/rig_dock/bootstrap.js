/* BEGIN OWRX RIG DOCK - managed by install.py */
(function () {
    'use strict';
    if (window.owrxRigDockLoader) return;
    var original = Plugins.load;
    var replaced = new Set(['rig_skin', 'mode_selector', 'audio_filter']);
    Plugins.load = function (name) {
        var id = String(name).split(/[?#]/)[0].split('/').pop().replace(/\.js$/i, '');
        if (replaced.has(id)) {
            console.info('RIG Dock: skipped ' + id + ' (original file retained).');
            return Promise.resolve();
        }
        return original.apply(this, arguments);
    };
    window.owrxRigDockLoader = {original: original};
    Plugins.load('rig_dock');
}());
/* END OWRX RIG DOCK */
