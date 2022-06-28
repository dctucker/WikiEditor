var ResizingDragBar = require( './ResizingDragBar.js' );
var TwoPaneLayout = require( './TwoPaneLayout.js' );
var ErrorLayout = require( './ErrorLayout.js' );
var ManualWidget = require( './ManualWidget.js' );
var OnboardingPopup = require( './OnboardingPopup.js' );

/**
 * @class
 */
function RealtimePreview() {
	this.configData = mw.loader.moduleRegistry[ 'ext.wikiEditor' ].script.files[ 'data.json' ];
	// Preference name, must match what's in extension.json and Hooks.php.
	this.prefName = 'wikieditor-realtimepreview';
	this.userPref = this.getUserPref();
	this.enabled = this.userPref;
	this.twoPaneLayout = new TwoPaneLayout();
	this.pagePreview = require( 'mediawiki.page.preview' );
	// @todo This shouldn't be required, but the preview element is added in PHP
	// and can have attributes with values that aren't easily accessible from here,
	// and we need to duplicate here what Live Preview does in core.
	var $previewContent = $( '#wikiPreview' ).clone().html();
	this.$previewNode = $( '<div>' )
		.addClass( 'ext-WikiEditor-realtimepreview-preview' )
		.append( $previewContent );

	// Loading bar.
	this.$loadingBar = $( '<div>' ).addClass( 'ext-WikiEditor-realtimepreview-loadingbar' ).append( '<div>' );
	this.$loadingBar.hide();

	// Error layout.
	this.errorLayout = new ErrorLayout();
	this.errorLayout.getReloadButton().connect( this, {
		click: function () {
			// Re-show the manual message after the error message is closed.
			if ( this.inManualMode ) {
				this.manualWidget.toggle( true );
			}
			this.doRealtimePreview();
		}.bind( this )
	} );

	// Manual reload button (visible on hover).
	this.reloadButton = new OO.ui.ButtonWidget( {
		classes: [ 'ext-WikiEditor-reloadButton' ],
		icon: 'reload',
		label: mw.msg( 'wikieditor-realtimepreview-reload' ),
		accessKey: mw.msg( 'accesskey-wikieditor-realtimepreview' ),
		title: mw.msg( 'wikieditor-realtimepreview-reload-title' )
	} );
	this.reloadButton.connect( this, {
		click: function () {
			// Only refresh the preview if we're enabled.
			if ( this.enabled ) {
				this.doRealtimePreview( true );
			}
		}.bind( this )
	} );

	// Manual mode widget.
	this.manualWidget = new ManualWidget( this, this.reloadButton );
	this.inManualMode = false;

	this.twoPaneLayout.getPane2().append( this.manualWidget.$element, this.reloadButton.$element, this.$loadingBar, this.$previewNode, this.errorLayout.$element );
	this.eventNames = 'change.realtimepreview input.realtimepreview cut.realtimepreview paste.realtimepreview';
	// Used to ensure we wait for a response before making new requests.
	this.isPreviewing = false;
	this.previewPending = false;
	this.lastWikitext = null;
	// Used to average response times and automatically disable realtime preview if it's very slow.
	this.responseTimes = [];

	$( window ).on( 'resize', this.enableFeatureWhenScreenIsWideEnough.bind( this ) );
}

/**
 * @public
 * @param {Object} context The WikiEditor context.
 * @return {jQuery}
 */
RealtimePreview.prototype.getToolbarButton = function ( context ) {
	this.context = context;
	var $uiText = context.$ui.find( '.wikiEditor-ui-text' );

	// Fix the height of the textarea, before adding a resizing bar below it.
	var height = context.$textarea.height();
	$uiText.css( 'height', height + 'px' );
	context.$textarea.removeAttr( 'rows cols' );
	context.$textarea.addClass( 'ext-WikiEditor-realtimepreview-textbox' );

	// Add the resizing bar.
	var bottomDragBar = new ResizingDragBar( { isEW: false } );
	$uiText.after( bottomDragBar.$element );

	// Create and configure the toolbar button.
	this.button = new OO.ui.ToggleButtonWidget( {
		label: mw.msg( 'wikieditor-realtimepreview-preview' ),
		icon: 'article',
		value: this.enabled,
		framed: false,
		// T305953; So we can find usage of this class later: .tool
		classes: [ 'tool', 'ext-WikiEditor-realtimepreview-button' ]
	} );
	this.button.connect( this, { change: [ this.toggle, true ] } );
	if ( !this.isScreenWideEnough() ) {
		this.button.toggle( false );
	}

	// Add the onboarding popup.
	var onboardingPopup = new OnboardingPopup();
	this.button.connect( onboardingPopup, { change: onboardingPopup.onPreviewButtonClick } );

	return $( '<div>' ).append( this.button.$element, onboardingPopup.$element );
};

/**
 * Get the user preference for Realtime Preview.
 *
 * @public
 * @return {boolean}
 */
RealtimePreview.prototype.getUserPref = function () {
	return ( typeof this.userPref !== 'undefined' ) ? this.userPref : mw.user.options.get( this.prefName ) > 0;
};

/**
 * Set enabled variable to `true` or `false`, which enables or disable Realtime Preview.
 *
 * @param {boolean} enable Whether to set enabled to `true` or `false`
 * @param {boolean} saveUserPref Whether to save the user preference.
 * @public
 */
RealtimePreview.prototype.setEnabled = function ( enable, saveUserPref ) {
	this.enabled = ( typeof enable === 'boolean' ) ? enable : false;
	this.toggle( saveUserPref );
};

/**
 * Save the user preference for Realtime Preview.
 *
 * @private
 */
RealtimePreview.prototype.saveUserPref = function () {
	this.userPref = this.enabled ? 1 : 0;
	( new mw.Api() ).saveOption( this.prefName, this.userPref );
};

/**
 * Toggle the two-pane preview display.
 *
 * @param {boolean} saveUserPref Whether to save the user preference.
 * @private
 */
RealtimePreview.prototype.toggle = function ( saveUserPref ) {
	var $uiText = this.context.$ui.find( '.wikiEditor-ui-text' );
	var $textarea = this.context.$textarea;

	// Save the current cursor selection.
	var textareaHasFocus = $textarea.is( ':focus' );
	var cursorPos = $textarea.textSelection( 'getCaretPosition', { startAndEnd: true } );

	// Remove or add the layout to the DOM.
	if ( this.enabled ) {
		// Move height from the TwoPaneLayout to the text UI div.
		$uiText.css( 'height', this.twoPaneLayout.$element.height() + 'px' );

		// Put the text div back to being after the layout, and then hide the layout.
		this.twoPaneLayout.$element.after( $uiText );
		this.twoPaneLayout.$element.hide();

		// Remove the keyup handler.
		$textarea.off( this.eventNames );

		// Let other things happen after disabling.
		mw.hook( 'ext.WikiEditor.realtimepreview.disable' ).fire( this );

	} else {
		// Add the layout before the text div of the UI and then move the text div into it.
		$uiText.before( this.twoPaneLayout.$element );
		this.twoPaneLayout.setPane1( $uiText );
		this.twoPaneLayout.$element.show();

		// Move explicit height from text-ui (which may have been set via manual resizing), to panes.
		this.twoPaneLayout.$element.css( 'height', $uiText.height() + 'px' );
		$uiText.css( 'height', '100%' );

		// Load the preview when enabling,
		this.doRealtimePreview();
		// and also on keyup, change, paste etc.
		$textarea
			.off( this.eventNames )
			.on( this.eventNames, this.getEventHandler() );

		// Hide or show the manual-reload message bar.
		this.manualWidget.toggle( this.inManualMode );

		// Let other things happen after enabling.
		mw.hook( 'ext.WikiEditor.realtimepreview.enable' ).fire( this );
	}

	// Restore current selection.
	if ( textareaHasFocus ) {
		$textarea.trigger( 'focus' );
		$textarea.textSelection( 'setSelection', { start: cursorPos[ 0 ], end: cursorPos[ 1 ] } );
	}

	// Record the toggle state and update the button.
	this.enabled = !this.enabled;
	this.button.$element.toggleClass( 'tool-active', this.enabled ); // T305953
	this.button.setFlags( { progressive: this.enabled } );

	if ( typeof saveUserPref === 'undefined' || ( typeof saveUserPref === 'boolean' && saveUserPref ) ) {
		this.saveUserPref();
	}
};

/**
 * @public
 * @return {Function}
 */
RealtimePreview.prototype.getEventHandler = function () {
	return mw.util.debounce(
		function () {
			// Only do preview if we're not in manual mode (as set in this.checkResponseTimes()).
			if ( !this.inManualMode ) {
				this.doRealtimePreview();
			}
		}.bind( this ),
		this.configData.realtimeDebounce
	);
};

/**
 * Check if screen meets minimum width requirement for Realtime Preview.
 *
 * @public
 * @return {boolean}
 */
RealtimePreview.prototype.isScreenWideEnough = function () {
	return this.context.$ui.width() > 600;
};

/**
 * Display feature (buttons and functionality) only when screen is wide enough
 *
 * @private
 */
RealtimePreview.prototype.enableFeatureWhenScreenIsWideEnough = function () {
	var previewButtonIsVisible = this.button.isVisible();
	var isScreenWideEnough = this.isScreenWideEnough();
	if ( !isScreenWideEnough && previewButtonIsVisible ) {
		this.button.toggle( false );
		this.reloadButton.setDisabled( true );
		if ( this.enabled ) {
			this.setEnabled( true, false );
		}
	} else if ( isScreenWideEnough && !previewButtonIsVisible ) {
		this.button.toggle( true );
		this.reloadButton.setDisabled( false );
		// if user preference and realtime disable
		if ( !this.enabled && this.getUserPref() ) {
			this.setEnabled( false, false );
		}
	}
};

/**
 * @private
 * @param {jQuery} $msg
 */
RealtimePreview.prototype.showError = function ( $msg ) {
	this.$previewNode.hide();
	this.reloadButton.toggle( false );
	// There is no need for a default message because mw.Api.getErrorMessage() will
	// always provide something (even for no network connection, server-side fatal errors, etc.).
	this.errorLayout.setMessage( $msg );
	this.errorLayout.toggle( true );
};

/**
 * @private
 * @param {number} time
 */
RealtimePreview.prototype.checkResponseTimes = function ( time ) {
	// Don't track response times if we're already in manual mode.
	if ( this.inManualMode ) {
		return;
	}

	this.responseTimes.push( Date.now() - time );
	if ( this.responseTimes.length < 3 ) {
		return;
	}

	var totalResponseTime = this.responseTimes.reduce( function ( a, b ) {
		return a + b;
	}, 0 );

	if ( ( totalResponseTime / this.responseTimes.length ) > this.configData.realtimeDisableDuration ) {
		this.inManualMode = true;
		this.manualWidget.toggle( true );
	}

	this.responseTimes.shift();
};

/**
 * @private
 * @param {boolean} forceUpdate For the preview to update, even if the wikitext is unchanged,
 *  e.g. when the user presses the 'reload' button.
 */
RealtimePreview.prototype.doRealtimePreview = function ( forceUpdate ) {
	// Wait for a response before making any new requests.
	if ( this.isPreviewing ) {
		// Queue up one final preview once this one finishes.
		this.previewPending = true;
		return;
	}

	var $textareaNode = $( '#wpTextbox1' );
	var wikitext = $textareaNode.textSelection( 'getContents' );
	if ( !forceUpdate && wikitext === this.lastWikitext ) {
		// Wikitext unchanged, no update necessary
		return;
	}
	this.lastWikitext = wikitext;

	this.isPreviewing = true;
	this.$loadingBar.show();
	this.$previewNode.show();
	this.reloadButton.setDisabled( true );
	this.manualWidget.setDisabled( true );
	this.errorLayout.toggle( false );
	var loadingSelectors = this.pagePreview.getLoadingSelectors();
	loadingSelectors.push( '.ext-WikiEditor-realtimepreview-preview' );
	loadingSelectors.push( '.ext-WikiEditor-ManualWidget' );
	loadingSelectors.push( '.ext-WikiEditor-realtimepreview-ErrorLayout' );
	var time = Date.now();

	this.pagePreview.doPreview( {
		$textareaNode: $textareaNode,
		$previewNode: this.$previewNode,
		$spinnerNode: false,
		loadingSelectors: loadingSelectors
	} ).done( function () {
		this.errorLayout.toggle( false );
	}.bind( this ) ).fail( function ( code, result ) {
		this.showError( ( new mw.Api() ).getErrorMessage( result ) );
		mw.log.error( 'WikiEditor realtime preview error', result );
	}.bind( this ) ).always( function () {
		this.$loadingBar.hide();
		this.reloadButton.setDisabled( false );
		if ( !this.errorLayout.isVisible() ) {
			// Only re-show the reload button if no error message is currently showing.
			this.reloadButton.toggle( true );
		}
		this.manualWidget.setDisabled( false );
		this.isPreviewing = false;
		this.checkResponseTimes( time );

		if ( this.previewPending ) {
			this.previewPending = false;
			this.doRealtimePreview();
		}
	}.bind( this ) );
};

module.exports = RealtimePreview;
