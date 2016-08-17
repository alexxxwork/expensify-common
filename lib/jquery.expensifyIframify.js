/**
 * This is a jQuery plugin that provides some iFrame functionality like
 * posting messages to the parent window.
 *
 * Usage:
 *
 * From inside the iFrame:
 * $.fn.expensifyIframeify( 'resize', { height: 100, width: 400 } );
 * $.fn.expensifyIframeify( 'tellParent', { name: 'say', data: { msg: 'Hello world!' } } );
 *
 * From inside the parent:
 * $( '#myIframe' ).expensifyIframeify( 'on', 'resize', function( data ) { ... } );
 * $( '#myIframe' ).expensifyIframeify( 'on', 'say', function( data ) {
 *     // alerts "Hello world!"
 *     alert( data.msg );
 * });
 */

module.exports = {
    /**
     * Loads the widget into jQuery
     *
     * @param {jQuery} $
     * @param {Underscore} _
     */
    load($, _) {
        /**
         * Holds the value normally stored in window.location.origin but it's calculated
         * according to the suggested solutions
         * Issue:
         * - https://github.com/Expensify/Expensify/issues/13192#issuecomment-100322844
         * Solution suggested in the following sites:
         * - http://stackoverflow.com/questions/22564167/window-location-origin-gives-wrong-path-when-using-ie
         * - http://tosbourn.com/a-fix-for-window-location-origin-in-internet-explorer/
         *
         * Believe it or not before this change this was causing a syntax error in IE10 that disappears with this change
         *
         * @type {String} jQuery Element
         */
        const defaultOrigin = `${window.location.protocol}//${window.location.hostname}`;

        /**
         * Any events coming from these subdomains are OK
         * @type {String[]}
         */
        const whiteListedSubdomains = ['www', 'secure', 'staging-secure', 'staging', 'salesforce'];

        /**
         * Holds a reference to the jQuery iFrame object
         *
         * @type {Object} jQuery Element
         */
        let self = null;

        /**
         * Whether or not the parent window is listening to the message event
         *
         * @type {Boolean}
         */
        let parentIsListening = false;

        /**
         * Whether or not the plugin has been initialized
         * @type {Boolean}
         */
        let wasInitalized = false;

        /**
         * Whether or not the iframe is listening to the message event
         *
         * @type {Boolean}
         */
        let iframeIsListening = false;

        /**
         * Keeps a record of if this script is running from the "parent" or the "iframe"
         * so that we only have to do this logic once.
         */
        let whatIAm;

        /**
         * Default settings for our plugin
         *
         * @type {Object}
         */
        let settings = {
            origin: defaultOrigin,
            debug: true
        };

        /**
         * Holds all of our registered event handlers
         *
         * @type {Object}
         */
        let eventHandlers = {};

        /**
         * A method for logging things to the console for debugging
         */
        function log(...args) {
            if (settings.debug) {
                // Make an array out of our arguments
                const mainArguments = Array.prototype.slice.call(args);
                const source = window.parent === window ? 'Parent' : 'Iframe';
                mainArguments.unshift(`${source}:`);
                mainArguments.unshift('[EXPENSIFYIFRAMEIFY]');
                console.log(...mainArguments);
            }
        }

        /**
         * Returns the proper subdomain for the non-secure origin, depending on if we are in an iframe or not
         *
         * @return {String}
         */
        function getNonsecureSubdomain() {
            const hostname = whatIAm === 'iframe'
                ? window.parent.location.hostname
                : window.location.hostname;
            return hostname.split('.').shift();
        }

        /**
         * Forms the message to send to our parent. The message structure is like:
         *
         * Full example:
         * iframeify:<iframeId>:<name>|<data>
         *
         * Lite example:
         * iframeify:<name>
         *
         * Where:
         *     - <iframeId> (optional) is the "id" attribute of the iframe
         *     - <name> (required) is the name of the event
         *     - <data> (optional) is a stringified glob of data
         *
         * @param {string} name the name of the message to send
         * @param {object} data to send in the message
         * @param {boolean|undefined} postToIframe if true, then we post the message
         *                                         to the iFrame or else we post
         *                                         the message to the parent
         */
        function postMessage(name, data, postToIframe) {
            let msg = 'iframeify';
            const nonsecureSubdomain = getNonsecureSubdomain();
            let newOrigin;

            if (self.iframeId) {
                msg += `:${self.iframeId}`;
            }

            msg += `:${name}`;

            if (data) {
                msg += '|';
                msg += JSON.stringify(data);
            }

            // Sending message from the iFrame to the parent
            // Only post a message if this is in an iFrame
            if (!postToIframe && window.parent !== window) {
                // We need to swap the origin from the secure subdomain to the non-secure subdomain

                // Handle production subdomains
                if (settings.origin.search('//secure.expensify') > -1) {
                    newOrigin = settings.origin.replace('//secure.expensify', `//${nonsecureSubdomain}.expensify`);
                } else if (settings.origin.search('//staging-secure.expensify') > -1) {
                    // Handle staging subdomains
                    newOrigin = settings.origin.replace('//staging-secure.expensify', '//staging.expensify');
                }
                log('posting message to', newOrigin, msg);
                window.parent.postMessage(msg, newOrigin);
            }

            // Sending message from the parent to the iFrame
            if (postToIframe && self[0].contentWindow) {
                // We need to swap the origin from the non-secure subdomain to the secure subdomain

                // Handle production subdomains
                if (nonsecureSubdomain !== 'staging' && settings.origin.search(`//${nonsecureSubdomain}.expensify`) > -1) {
                    newOrigin = settings.origin.replace(`//${nonsecureSubdomain}.expensify`, '//secure.expensify');
                } else if (settings.origin.search('//staging.expensify') > -1) {
                    // Handle staging subdomains
                    newOrigin = settings.origin.replace('//staging.expensify', '//staging-secure.expensify');
                }
                log('posting message to', newOrigin, msg);
                self[0].contentWindow.postMessage(msg, newOrigin);
            }
        }

        /**
         * Calls all the methods associated with the event name
         * and passes it the given data
         *
         * @param {string} name of the event
         * @param {mixed} data passed to the event handler
         * @param {string} [iframeId]
         */
        function trigger(name, data, iframeId) {
            log(`heard event "${name}"`, data);
            iframeId = iframeId || self.iframeId;
            if (eventHandlers[iframeId] && eventHandlers[iframeId][name] && eventHandlers[iframeId][name].length) {
                const listeners = eventHandlers[iframeId][name];
                for (let i = 0; i < listeners.length; i++) {
                    listeners[i](data);
                }
            }
        }

        /**
         * Handles the window message by parsing the data
         * and relaying it to our event listeners
         *
         * @param {Event} event jQuery event
         */
        function handleWindowMessage(event) {
            let msgParts = null;
            let nameParts = null;
            let iframeId = null;
            let eventName = null;
            let data = null;

            // Use the original event to get our data properly
            event = event.originalEvent;

            // All events must have an origin
            if (!event.origin) {
                return;
            }

            // Check the origin which must have our whitelisted subdomains in it
            const urlArray = event.origin.split('://');
            if (urlArray && urlArray.length && urlArray.length > 1) {
                const domainArray = urlArray[1].split('.');

                // Remove the subdomain
                domainArray.shift();

                const domainWithoutSubdomain = domainArray.join('.');
                const allowedOrigin = _(whiteListedSubdomains).find(subdomain => event.origin === `${urlArray[0]}://${subdomain}.${domainWithoutSubdomain}`);

                if (!allowedOrigin) {
                    return;
                }
            }

            if (!event.data || !_.isString(event.data)) {
                return;
            }

            // Get the pieces of our message (should be two)
            msgParts = event.data.split('|');

            if (!msgParts.length) {
                return;
            }

            // Get the pieces of our name (should be two or three)
            // and extract the event name and the iframe ID
            nameParts = msgParts[0].split(':');

            if (!nameParts.length || nameParts.length > 3) {
                return;
            }

            if (nameParts.length === 3) {
                iframeId = nameParts[1];
                eventName = nameParts[2];
            } else if (nameParts.length === 2) {
                eventName = nameParts[1];
            }

            // Get the data
            if (msgParts.length > 1) {
                try {
                    data = JSON.parse(msgParts[1]);
                } catch (e) {
                    // This should only happen if someone didn't code something right
                    console.error('Could not parse JSON response for some reason', event.data);
                }
            }

            // Trigger any listeners for this event
            trigger(eventName, data, iframeId);
        }

        const actions = {

            // Add actions here

            /**
             * Tells the parent to dynamically resize the iFrame
             *
             * @param {object} args
             * @param {string} args.id the ID of the iFrame to resize
             * @param {integer} args.height (optional) the height to set the iFrame to
             * @param {integer} args.width (optional) the width to set the iFrame to
             */
            resize(args) {
                const size = {};

                if (args.height !== undefined) {
                    size.height = args.height;
                }

                if (args.width !== undefined) {
                    size.width = args.width;
                }

                postMessage('resize', size);
            },

            /**
             * Tell our parent a generic message
             *
             * @param {object} args
             * @param {string} args.name the name of the message to post
             * @param {object} args.data (optional) to send with the message
             */
            tellParent(args) {
                postMessage(args.name, args.data);
            },

            /**
             * Tell our iFrame a generic message
             *
             * @param {object} args
             * @param {string} args.name the name of the message to post
             * @param {object} args.data (optional) to send with the message
             */
            tellIframe(args) {
                postMessage(args.name, args.data, true);
            },

            /**
             * Register an event handler. The callback will be stored
             * for the particular iFrame ID so that you can listen to
             * multiple iFrames if you want
             *
             * @param {string} name of the event
             * @param {Function} callback
             */
            on(name, callback) {
                log(`listening to event "${name}"`);
                if (!eventHandlers[self.iframeId]) {
                    eventHandlers[self.iframeId] = {};
                }

                if (!eventHandlers[self.iframeId][name]) {
                    eventHandlers[self.iframeId][name] = [];
                }

                eventHandlers[self.iframeId][name].push(callback);
            },

            /**
             * Unregister all handlers for an event. If name is null
             * then all handlers will be removed
             *
             * @param {string} name (optional) of the event
             */
            off(name) {
                log(`stop listening to event "${name}"`);
                if (self.iframeId) {
                    if (eventHandlers[self.iframeId]) {
                        if (!name) {
                            eventHandlers[self.iframeId] = {};
                        } else {
                            delete eventHandlers[self.iframeId][name];
                        }
                    }
                } else if (!name) {
                    eventHandlers = {};
                } else {
                    $.each(eventHandlers, (i, obj) => {
                        delete obj[name];
                    });
                }
            },

            /**
             * Tears down the plugin by
             * - removing all event handlers
             * - stop listening to the 'message' window event
             */
            destroy() {
                $(window).off('message', handleWindowMessage);
                parentIsListening = false;
                iframeIsListening = false;
                self = null;
            }
        };

        /**
         * The method that we expose to jQuery. Is used to set options
         * or perform actions
         *
         * @param {mixed} actionOrOptions string of an action to perform
         *                                object of options to set
         * @param {object} args to pass to an action method
         * @param {function} callback (optional) for event handlers
         *
         * @return {[type]}
         */
        $.fn.expensifyIframeify = function (actionOrOptions, args, callback) {
            const urlArray = defaultOrigin.split('://');
            const domainArray = urlArray[1].split('.');
            const subdomain = domainArray.shift();
            const domainWithoutSubdomain = domainArray.join('.');

            document.domain = domainWithoutSubdomain;
            self = this;

            // The iframeId is pulled from the frameElement (if this is inside an iFrame)
            // or it's pulled from the element that this plugin was called from.
            //
            // Example:
            // $( '#myIframe' ).expensifyIframeify();
            //
            // 'myIframe' would be the frameId
            self.iframeId = window.top === window ? $(window.frameElement).attr('id') : self.attr('id');

            // Figure out if we are doing an action or setting options
            if (typeof actionOrOptions === 'string') {
                if (typeof actions[actionOrOptions] !== 'undefined') {
                    actions[actionOrOptions](args, callback);
                }
            } else {
                // Extend our default settings
                settings = $.extend(settings, actionOrOptions);
            }

            if (!wasInitalized) {
                // Determine if this is the parent, or the iframe
                // Because our site runs inside of an iframe in salesforce, the parent
                // will actually think it's an iframe too. So here, we detect that we're on
                // the salesforce subdomain and we know that we should be the parent
                whatIAm = (window.parent === window || subdomain === 'salesforce')
                    ? 'parent'
                    : 'iframe';
                log('I am the:', whatIAm);
                wasInitalized = true;
            }

            // If this is the parent page, then we can start listening to messages
            // from the iFrame
            if (whatIAm === 'parent' && !parentIsListening) {
                $(window).on('message', handleWindowMessage);
                parentIsListening = true;
                log('window is listening for messages');
            }

            // If this is the iFrame, then we can start listening to messages
            // from the iFrame
            if (whatIAm === 'iframe' && !iframeIsListening) {
                $(window).on('message', handleWindowMessage);
                iframeIsListening = true;
                log('window is listening for messages');
            }

            // make this plugin chainable
            return this;
        };
    }
};