import jwt_decode from 'jwt-decode';

/**
 * Class to handle access and refresh JWT tokens for renewal and check validation.
 * This library provide you automatic check validation over time expiration and server.
 * Also every 1 second check locally if access token was expired and try to renewal with a refresh token in case you have it
 * doing a HTTP request to custom endpoints.
 */
export default class WebAuth {

    /**
     * @param Object.[keys] {Object=} - Object with keys name to save in storage.
     * @param Object.[keys.access] {String} - Key name of access token.
     * @param Object.[keys.refresh] {String} - Key name of refresh token.
     * @param Object.tokens {Object} - Object with access and refresh token.
     * @param Object.tokens.access {String} - JWT access token.
     * @param Object.tokens.refresh {String} - JWT refresh token.
     * @param Object.[remember] {Boolean} - Save session after close window/browser or not.
     * @param Object.config {Object} - Object with configuration.
     * @param Object.config.url {Object} - Object with authorization endpoints configuration.
     * @param Object.config.url.base {String} - FQDN of Rest API.
     * @param Object.config.url.endpoints {Object} - Object with endpoints of check and renewal.
     * @param Object.config.url.endpoints.check {String} - Endpoint to check validation of JWT access token.
     * @param Object.config.url.endpoints.refresh {String} - Endpoint to renewal JWT access token providing refresh token.
     * @param Object.config.url.keys {Object} - Object with access and refresh keys names to get in HTTP response
     * @param Object.config.url.keys.access {String} - Key name to get access token in response.
     * @param Object.config.url.keys.refresh {String} - Key name to get refresh token in response.
     * @param Object.config.url.status {Number} - HTTP status code you will expect receive in endpoint of access token renewal.
     * @param Object.config.url.contentType {String} - Content-Type of request to set in headers.
     * @param Object.config.url.mime="json" {String} - Type of parser to use in HTTP response, read about https://developer.mozilla.org/es/docs/Web/API/Body.
     * @param Object.config.headers {Object<any>} - Add custom headers to set in check and renewal HTTP request.
     * @param Object.[config.prefix]="Bearer" {String} - Prefix of Authorization header.
     * @param Object.config.methods {Object} - Object with access and refresh endpoints method.
     * @param Object.config.methods.access {String} - Method of endpoint to check validation of access token.
     * @param Object.config.methods.refresh {String} - Method of endpoint to renewal access token.
     * @param Object.[config.bodies] {Object} - Add custom payload to send in HTTP requests.
     * @param Object.[config.bodies.access={}] {Object|String} - Custom body to send in check validation of access token.
     * @param Object.[config.bodies.refresh={}] {Object|String} - Custom body to send in renewal of access token.
     * @param Object.[config.maxAttempts] {number} - Number of attempts before set refresh token expired by no-internet or >=500 status code.
     * @param Object.config.updateToken {Function} - Function fired after renewal access token successfully, useful for use with axios or any http framework that manage Authorization header.
     * @param Object.expired {Function} - Event fired when refresh token is expired.
     */
    constructor({
        keys = {access: 'auth-key', refresh: 'auth-key-refresh'},
        tokens = {access: null, refresh: null},
        remember = false,
        config = {},
        expired = () => {},
    }) {
        this.tokens = tokens;
        this.keys = keys;
        this.remember = remember;
        this.config = config;
        this.expired = expired;

        this.payloads = { access: null, refresh: null }; // Payload of access and refresh token
        this._interval = null;
    }

    /**
     * Initialize WebAuth
     * @returns {Promise<Error|*>}
     * @public
     */
    async init() {
        return new Promise(async (resolve) => {
            this._setTokens();
            this.remember = this.remember || this.constructor.checkStorage(this.keys.access).remember;
            this._setup();

            const expired = await this.checkExpiration('access');
            const pathnameObject = {pathname: Object.assign(this.constructor.getSearchOrHash(), this._nestedPathname())};
            const payload = {valid: !expired, tokens: this.tokens, payloads: this.payloads};
            const finalResult = Object.assign(payload, pathnameObject);

            const {access} = (this._validateURL()) ? this.config.url['endpoints'] : {};
            if (!access) throw new Error('Please check the endpoints object in config key');

            const serverResult = await this._toServer({endpoint: access}).catch(status => status);
            if (typeof serverResult === 'object') resolve(finalResult);

            if (!(this._checkStatus(serverResult) && 'refresh' in this.tokens)) return new Error(`Server respond with status code ${serverResult} and expect ${this.config.url.status}.`);

            const newToken = await this._getNewAccessToken();
            if (!(newToken instanceof Error)) resolve(finalResult);
            return new Error(`Server respond with status code ${newToken} and expect ${this.config.url.status}.`);
        });
    }

    /**
     * Check if the token is expired or not
     * @param token {String<JWT>} - JWT token you want check
     * @returns {boolean} - Expiration value of JWT
     * @public
     */
    checkExpiration(token = 'access') {
        const expiration = this.payloads[token].exp * 1000;
        return expiration <= new Date().getTime();
    }

    /**
     * Clean tokens from storage and interval
     * @public
     */
    cleanTokens() {
        // Remove from localStorage
        window.localStorage.removeItem(this.keys.access);
        window.localStorage.removeItem(this.keys.refresh);
        // Remove from sessionStorage
        window.sessionStorage.removeItem(this.keys.access);
        window.sessionStorage.removeItem(this.keys.refresh);
        window.clearInterval(this._interval);
    }

    /**
     * Function to set expired JWT and clean tokens
     * @public
     */
    expire() {
        this.cleanTokens();
        this.expired();
    }

    /**
     * Set JWT access and refresh tokens
     * @param access {String<JWT>} - Access JWT token
     * @param refresh {String<JWT>} - Refresh JWT token
     * @returns {{access: String|null, refresh: String|null}} - Object with access and refresh tokens
     * @private
     */
    _setTokens(access = null, refresh = null) {
        if (access) this.tokens.access = access || this.tokens.access || this._getFromStorage(this.keys.access);
        if (refresh) this.tokens.refresh = refresh || this.tokens.access || this._getFromStorage(this.keys.refresh);
        return {access: this.tokens.access, refresh: this.tokens.access};
    }

    /**
     * Setup JWT access and refresh tokens on storage, create checker and fire event update access token.
     * @private
     */
    _setup() {
        const storage = (this.remember) ? 'localStorage' : 'sessionStorage';
        this.cleanTokens();
        if (!this.tokens.access) throw new Error('accessToken is not defined');
        window[storage].setItem(this.keys.access, this.tokens.access);

        if (this.tokens.refresh) window[storage].setItem(this.keys.refresh, this.tokens.refresh);

        this._setPayload('access');
        if (this.tokens.access) this._setPayload('refresh');

        this._createChecker();
        this._updateAccessToken(); // This fire event to update access token in frameworks like axios
    }

    /**
     * Decode and set payload of access or refresh JWT
     * @param token {String<JWT>} - Name of token key like access or refresh
     * @private
     */
    _setPayload(token = null) {
        if (!token) throw new Error('Please provide a correct token type in _setPayload.');
        const payload = jwt_decode(this.tokens[token]);
        this.payloads[token] = (typeof payload === 'object') ? payload : {};
        if (typeof payload !== 'object') new Error('JWT is not valid, please check structure.');
    }

    /**
     * Get storage option for JWT token and remember option based on storage
     * @param key {String} - Storage key name
     * @returns {{remember: boolean, storage: (string)}}
     */
    static checkStorage(key = '') {
        const storage = (window.localStorage.getItem(key)) ? 'localStorage' : 'sessionStorage';
        const remember = (storage === 'localStorage');
        return { storage, remember };
    }

    /**
     * Get value from storage
     * @param key {String} - Storage key name
     * @returns {String<JWT>} - Return JWT token
     * @private
     */
    _getFromStorage(key) {
        return window[this.constructor.checkStorage(key).storage].getItem(key);
    }

    /**
     * Get pathname of current window [WARNING]: Caution using with iframe
     * @param path {String} - Set if you want take from parent or top
     * @returns {*|string} - Pathname
     */
    static getPathname(path = null) {
        return (path) ? window.location.pathname : window[path].location.pathname; // Get the pathname
    }

    /**
     * Return pathname in object format and nested indexed schema
     * @returns {{plain: (*|string), byLevels: *}}
     * @private
     */
    _nestedPathname() {
        let pathname = this.constructor.getPathname();
        const split = pathname.split('/').shift();
        const byLevels = split.map((path, index) => ({ path, level: index }));
        return {plain: this.constructor.getPathname(), byLevels};
    }

    /**
     * Get search or hash of current window
     * @param path {String} - Set if you want take from parent or top
     * @returns {{}}
     */
    static getSearchOrHash(path = null) {
        const searchFormatter = parameters => {
          const object = {};
          parameters.split('&').forEach(parameter => object[parameter.split('=')[0]] = parameter.split('=')[1]);
          return object;
        };
        const formatter = value => {
            const object = {};
            const parameters = value.split('?');
            parameters.forEach(parameter => {
                if (parameter.includes('#')) object.hash = parameter.replace('#');
                else if (parameter.includes('&')) object.search = searchFormatter(parameter);
            });
            return object;
        };
        const {search, hash} = (path) ? window.location : window[path].location;
        return (search) ? formatter(search) : formatter(hash);
    }

    /**
     * Send to server a request for check validation or get a new access token.
     * @param endpoint {String} - Rest API endpoint.
     * @param token {String} - Key object where is configuration to do the request.
     * @returns {Promise<Error|any>}
     * @private
     */
    async _toServer({endpoint, token = 'access'}) {
        if (!this._validateURL()) return;
        const header = new Headers();
        const {headers, url: { base }, prefix, methods} = this.config;
        if (headers && headers[token]) Object.keys(headers).forEach(key => {
           const keyToLowerCase = key.toLowerCase();
           if (keyToLowerCase !== 'authorization') header.append(key, headers[key]);
        });
        header.append('Authorization', `${prefix || 'Bearer'} ${this.tokens['access']}`);
        if (this._validateURL() && 'contentType' in this.config.url) header.append('Content-Type', this.config.url.contentType);
        else header.append('Content-Type', 'application/json');

        const payloadFetch = {
            method: (methods && methods[token]) ? methods[token] : 'POST',
            headers: header,
        };
        if (payloadFetch.method === 'POST') payloadFetch.body = JSON.stringify(this._parseBodyKeys());

        const response = await fetch(`${base}/${endpoint}`, payloadFetch);
        if (response instanceof Error) return new Error('Ups, something happen with your internet.');

        const status = response.status;
        const mimeType = (this._validateURL() && 'mime' in this.config.url) ? this.config.url.mime : 'json';
        if ((status > 199 && status < 300)) return await response[mimeType]();
        return status;
    }

    /**
     * Get a new access token from server
     * @returns {Promise<Error|any>}
     * @private
     */
    async _getNewAccessToken() {
        if (!(this._validateURL() && 'refresh' in this.tokens)) throw new Error('[Auth Web] Trying to get a access token without mandatory keys.');
        const {endpoints, keys} = this.config.url;
        const response = await this._toServer({endpoint: endpoints.refresh, token: 'refresh'});
        //TODO: Create max attempts when no internet connection
        if (response instanceof Error) return response;
        this.tokens.access = response[keys.access];
        this._setup();
        return response;
    }

    /**
     * Create a function that check JWT expiration every 1 second
     * @param [attempts] {number} - Attempts before set refresh JWT token like expired
     * @private
     */
    _createChecker(attempts = 0) {
        const handler = async () => {
            const isExpired = this.checkExpiration('access');
            if (isExpired && !('refresh' in this.tokens)) return this.expire();
            window.clearInterval(this._interval);
            const result = await this._getNewAccessToken();
            if (!(result instanceof Error)) return;
            if (typeof result === 'number' && this._checkStatus(result)) this.expire();
            else this._createChecker(attempts += 1);
        }
        const {maxAttempts = 3} = this.config;
        this._interval = (attempts <= maxAttempts) ? window.setInterval(handler, 1000) : this.expire();
    }

    /**
     * Validate exist all keys and types of keys are correct
     * @returns {boolean}
     * @private
     */
    _validateURL() {
        return (typeof this.config === 'object'
            && 'url' in this.config
            && typeof this.config.url === 'object'
            && 'endpoints' in this.config.url
            && typeof this.config.url['endpoints'] === 'object'
            && 'access' in this.config.url['endpoints']);
    }

    /**
     * Generate body with refresh token to send to server
     * @returns {Object} - Object with refresh token, not string.
     * @private
     */
    _parseBodyKeys() {
        const {refresh} = (this._validateURL()) ? this.config.bodies : {};
        if (refresh) this.config.bodies.refresh[this.config.url.keys.refresh] = this.tokens.refresh;
        return (this._validateURL()) ? this.config.bodies.refresh : {};
    }

    /**
     * Check HTTP status code of request
     * @param status {number} - HTTP status code
     * @returns {boolean} - Check if the HTTP status code is as expected
     * @private
     */
    _checkStatus(status) {
        const DefaultStatus = (this._validateURL() && 'status' in this.config.url) && this.config.url.status;
        return DefaultStatus === status;
    }

    /**
     * Fire update access token after renewal event
     * @private
     */
    _updateAccessToken() {
        if (this._validateURL() && 'updateToken' in this.config) this.config.updateToken();
    }
};
