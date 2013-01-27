define([
  '../event_emitter',
  './display_list',
  '../color',
  './timeline',
  '../tools',
  './registry',
  '../asset/asset_loader',
  './environment',
  './ui_event',
  '../uri',
  './require_wrapper'
], function(EventEmitter, displayList, color, Timeline,
            tools, Registry, AssetLoader, Environment,
            uiEvent, URI, requireWrapper) {
  'use strict';

  var hitch = tools.hitch;
  var DisplayList = displayList.DisplayList;

  /** @const */
  var DEFAULT_FRAMERATE = 30;

  /**
   * Helper used to collect all descendent IDs of a display list
   * (recursive)
   */
  function collectChildIds(displayList) {
    var ids = [];
    if (displayList) {
      var children = displayList.children;
      for (var child, i = 0; (child = children[i]); ++i) {
        ids.push(child.id);
        var subDisplayList = child.displayList;
        if (subDisplayList) {
          ids.push.apply(ids, collectChildIds(subDisplayList));
        }
      }
    }

    return ids;
  }

  /**
   * Constructs the movie root, i.e. the global `stage`.
   *
   * @classdesc A Stage instance is the root of your movie. There should never
   *  be a need to instantiate a new Stage from within a movie.
   * @name Stage
   * @constructor
   * @param {Object} messageChannel The messageChannel object used to
   *  communicate with the renderer
   * @param {DisplayList} displayList A display list. The stage delegates all
   *    child-related functionality to the displayList.
   *
   * @mixes EventEmitter
   * @mixes Timeline
   */
  function Stage(messageChannel, environment, loadScriptUrls, loadSubMovie, displayList) {
    this.registry = new Registry();
    this.loadScriptUrls = loadScriptUrls;
    this.loadSubMovie = loadSubMovie;

    if (!displayList) {
      displayList = new DisplayList();
    }
    displayList.owner = this;
    this.displayList = displayList;

    var assetLoader = this.assetLoader =
      new AssetLoader({})
        .on('request', hitch(this, this.loadAsset, null))
        .on('destroy', hitch(this, this.destroyAsset));

    this.env = environment;
    // Expose bonsai API in iframe window
    environment.initialize(this, assetLoader);
    environment.expose({});

    this.stage = this.root = this;
    this._canRender = true;

    Object.defineProperties(this, {
      id: {value: 0}
    });

    this._queuedFramesById = {};
    this._queuedFrames = [];

    this.messageChannel = messageChannel;
    messageChannel
      .on('message', this, this.handleEvent)
      .notifyRenderer({command:"isReady"});
  }

  var proto = Stage.prototype = /** @lends Stage.prototype */ {
    _isFrozen: true,

    assetBaseUrl: new URI(null, null, ''),
    height: Infinity,
    width: Infinity,

    /**
     * Destroys the stage
     *
     * @returns {this} The instance
     */
    destroy: function() {
      clearInterval(this._interval);
      return this;
    },

    /**
     * Freeze/destroy the loop
     */
    freeze: function() {
      clearInterval(this._interval);
      this._isFrozen = true;
      return this;
    },

    /**
     * Handles messages from the client.
     *
     * @private
     * @param {MessageEvent} message
     */
    handleEvent: function(message) {
      var command = message.command,
          data = message.data;
      switch (command) {
        case 'options':
          this.setOptions(data);
          break;
        case 'play':
        case 'stop':
        case 'freeze':
        case 'unfreeze':
          this[command](data);
          break;
        case 'assetLoadSuccess':
          this.assetLoader.handleEvent('load', data.id, data.loadData);
          break;
        case 'assetLoadError':
          this.assetLoader.handleEvent('error', data.id, data.loadData);
          break;
        case 'userevent':
          var displayObjectsRegistry = this.registry.displayObjects;
          var targetId = data.targetId;
          var target = targetId ? displayObjectsRegistry[targetId] : this;
          if (target) { // target might have been removed already
            var event = data.event;
            event.target = target;
            var relatedTargetId = data.relatedTargetId;
            if (relatedTargetId === 0 || relatedTargetId > 0) {
              event.relatedTarget = displayObjectsRegistry[relatedTargetId] || this;
            }

            uiEvent(event).emitOn(target);
          }
          break;
        case 'env':
          // Change environment vars
          tools.mixin(this.env.exports.env, data);
          this.env.exports.env.emit('change', data);
          break;
        case 'message':
          if ('category' in message) {
            this.emit('message:' + message.category, data);
          } else {
            this.emit('message', data);
          }
          break;
        case 'canRender':
          this._canRender = true;
          this.postFrames();
          break;
      }
    },

    /**
     * Sends a `loadAsset` message to the renderer
     */
    loadAsset: function(baseUrl, id, request, displayObjectType) {
      // Make asset urls absolute here
      baseUrl = baseUrl || this.assetBaseUrl;
      tools.forEach(request.resources, function(assetResource) {
        var src = URI.parse(assetResource.src);
        if (src.scheme !== 'data') {
          assetResource.src = baseUrl.resolveUri(src).toString();
        }
      });

      this.post({
        command: 'loadAsset',
        data: {
          id: id,
          type: displayObjectType,
          request: request
        }
      });
    },

    /**
     * Sends a `destroyAsset` message to the renderer
     */
    destroyAsset: function(id) {
      this.post({
        command: 'destroyAsset',
        data: { id: id }
      });
    },

    /**
     * Loads a sub movie and runs it in the context of a new Movie object
     * (should be provided by RunnerContext bootstrap)
     *
     * @param movieUrl URL of sub-movie (will use the dirname of the submovie as asset path)
     * @param {Function} callback A callback to be called when your movie has
     *  loaded. The callback will be called with it's first argument signifying
     *  an error. So, if the first argument is `null` you can assume the movie
     *  was loaded successfully.
     */
    loadSubMovie: function() {},

    /**
     * Returns a new Environment for a sub-movie. This is used by loadSubMovie,
     * which is provided by the context's bootstrap code
     *
     * @private
     * @returns {Environment} The Submovie Environment
     */
    getSubMovieEnvironment: function(subMovie, subMovieUrl) {
      subMovieUrl = this.assetBaseUrl.resolveUri(subMovieUrl);
      subMovie.url = subMovieUrl.toString();
      var assetBase = subMovieUrl.scheme === 'data' ? null : subMovieUrl;
      var environment = new Environment(this.env.global);
      var assetLoader = new AssetLoader(this.assetLoader.pendingAssets)
        .on('request', hitch(this, this.loadAsset, assetBase));
      environment.initialize(subMovie, assetLoader);
      return environment;
    },

    /**
     * Processes DisplayObjects in registry and prepares the message to send
     * to the renderer.
     *
     * When this method is called, it starts another 'tick-cycle'.
     * @private
     */
    loop: function() {

      this.emitFrame();

      var registry = this.registry;
      var movieRegistry = registry.movies;

      var movies = tools.removeValueFromArray(movieRegistry.movies);

      /*
        The `movies` array may contain gaps (if elements are removed from the
        stage during the iteration) and increase its length during the iteration
        (if timelines are added to the stage during iteration)
       */
      var len, movie, i = 0;
      while (i < len  // check whether we are within the cached length
          || i < (len = movies.length)) { // check whether we are within the actual length and cache the length

        movie = movies[i];
        if (movie) {
          movie.emitFrame();
        }

        i += 1;
      }


      // Emit an event to mark the fact that we've emitted all submovies' frames:
      this.emit('subMoviesAdvanced');

      var moviesToIncrement = [this].concat(movies);
      // Go through all movies and increment their respective frames:
      for (i = 0, len = moviesToIncrement.length; i < len; ++i) {
        movie = moviesToIncrement[i];
        if (movie && movie.isPlaying) {
          movie.incrementFrame();
        }
      }

      var message;
      var messagesIndexesById = this._queuedFramesById;
      var queuedFrames = this._queuedFrames;
      var displayObjectRegistry = registry.displayObjects,
          needsDrawRegistry = registry.needsDraw,
          needsInsertionRegistry = registry.needsInsertion;

      for (var id in needsDrawRegistry) {
        var obj = needsDrawRegistry[id];
        var existingMessageIndex = messagesIndexesById[id];

        // if not in display object registry, object has been removed
        if (displayObjectRegistry[id]) {
          message = obj.composeRenderMessage ?
            obj.composeRenderMessage(queuedFrames[existingMessageIndex]) :
            // obj is a pure diplayList style class
            // this poses a problem, as we'll probably need to pass this
            // to the renderer, too.
            message = { id: +id };

          if (id in needsInsertionRegistry) {
            delete needsInsertionRegistry[id];
            var next = obj.next;
            message.next = next && next.id;
            message.parent = obj.parent.id;
          }

          obj.emit('render');

          delete message.detach;
        } else {

          // collect ids of all children (all levels) that are removed together with the parent
          var childIds = collectChildIds(obj.displayList);

          message = {id: +id, detach: true};
          if (childIds.length) {
            message.children = childIds;
          }

        }
        delete needsDrawRegistry[id];

        if (existingMessageIndex >= 0) {
          queuedFrames[existingMessageIndex] = message;
        } else {
          messagesIndexesById[id] = queuedFrames.push(message) - 1;
        }
      }

      this.emit('exitFrame');

      this.postFrames();
    },

    /**
     * Sends data to the client.
     *
     * @param data
     * @returns {this} The instance
     */
    post: function(data) {
      this.messageChannel.notifyRenderer(data);
      return this;
    },

    postFrames: function() {
      var queuedFrames = this._queuedFrames;

      if (this._canRender && queuedFrames.length) {
        this._canRender = false;
        this._queuedFramesById = {};
        this._queuedFrames = [];
        this.post({
          command: 'render',
          data: queuedFrames,
          frame: this.currentFrame
        });

      }
    },

    /**
     * Sends a message to the renderer / stage controller
     *
     * @param [category=null] The message category
     * @param messageData
     * @returns {this} The instance
     */
    sendMessage: function(category, messageData) {
      if (arguments.length > 1) {
        return this.post({
          command: 'message',
          category: category,
          data: messageData
        });
      } else {
        return this.post({
          command: 'message',
          data: category
        });
      }
    },

    /**
     * Set the framerate of the movie
     * @param {Number} framerate frames per second
     */
    setFramerate: function(framerate) {

      if (!framerate) {
        return;
      }

      var wasFrozen = this._isFrozen;
      this.freeze();
      this.framerate = Math.abs(framerate);
      if (!wasFrozen) {
        this.unfreeze();
      }
    },
    /**
     * Sets options on the stage
     *
     * @param {Object} options
     * @param {number} [options.framerate=30] Playback speed of the movie
     * @param {string} [options.baseUrl='.'] The base URL to use to resolve urls.
     * @param {string} [options.pluginUrl='.'] The base URL to use to resolve plugin location.
     * @param {Array} [options.plugins] A list of plugin names to load.
     * @returns {this} the stage intance.
     */
    setOptions: function(options) {
      this.options = options;
      this.baseUrl = URI.parse(options.baseUrl);
      var urls = options.urls || [];
      this.assetBaseUrl = URI.parse(
        // If assetBaseUrl is not defined then we use the primary
        // movie URL as the assumed base, with a last fallback to baseUrl:
        options.assetBaseUrl || options.url || (urls && urls[0]) || options.baseUrl
      );
      this.setFramerate(options.framerate || DEFAULT_FRAMERATE);
      this.width = +options.width || Infinity;
      this.height = +options.height || Infinity;

      this._loadUrls();

      return this;
    },

    _loadUrls: function() {
      var options = this.options;
      var urls = options.urls;
      var self = this;

      // setup a waiting loader
      var finishCallbacks = 0;
      var getLoader = function() {
        var loader = function(err) {
          if (err) {
            console.log('Load error');
          }
          finishCallbacks -= 1;
          if (finishCallbacks === 0) {
            self.unfreeze();
          }
        };
        finishCallbacks += 1;
        return loader;
      };

      // wrap AMD loader
      var global = this.env.global;
      var originalRequire = global.require;
      Object.defineProperty(global, 'require', requireWrapper(getLoader()));
      if (originalRequire) {
        /*
         We need to invoke the just registered setter for 'require' with the
         original require function (of require.js) to make it work correctly.
         */
        global.require = originalRequire;
      }

      var loadScriptUrls = this.loadScriptUrls;
      if (options.url) {
        urls.push(url);
      }
      if (options.code) {
        urls.push('data:text/javascript,' + encodeURIComponent(options.code));
      }
      if (loadScriptUrls) {
        if (urls) {
          loadScriptUrls(urls, getLoader());
        }
        this.loadScriptUrls = null;
        this.unfreeze();
      }
    },

    /**
     * Set the technique for rendering, currently only supporting value, 'crispEdges'.
     * @param {String} renderingType 'crispEdges'
     */
    setRendering: function(renderingType) {
      if (renderingType === 'crispEdges') {
        this.post({
          command: 'renderConfig',
          data: {
            item: 'crispEdges',
            value: true
          }
        });
      }
    },

    /**
     * Set the background color of the stage
     */
    setBackgroundColor: function(value) {
      this.post({
        command: 'renderConfig',
        data: {
          item: 'backgroundColor',
          value: color.parse(value)
        }
      });
    },

    /**
     * Unfreeze/initiate the loop
     */
    unfreeze: function() {
      if (this._isFrozen) {
        this._interval = setInterval(hitch(this, this.loop), 1000 / this.framerate);
        this._isFrozen = false;
      }
    }
  };

  tools.mixin(proto, EventEmitter, displayList.timelineMethods, Timeline);
  delete proto.markUpdate;

  return Stage;
});
