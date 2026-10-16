// ==UserScript==
// @name         IAG MapStore – fix GeoServer URLs
// @namespace    https://maps.iag.bg/
// @version      1.1.0
// @description  Пренасочва заявките към вътрешния GeoServer (172.16.4.132:5088) към https://maps.iag.bg
// @match        https://maps.iag.bg/*
// @homepageURL  https://github.com/Folktroll/iag-userscripts
// @supportURL   https://github.com/Folktroll/iag-userscripts/issues
// @downloadURL  https://raw.githubusercontent.com/Folktroll/iag-userscripts/main/iag-geoserver-fix.user.js
// @updateURL    https://raw.githubusercontent.com/Folktroll/iag-userscripts/main/iag-geoserver-fix.user.js
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
    'use strict';

    const BAD_ORIGIN = /https?:\/\/172\.16\.4\.132:5088/g;
    const GOOD_ORIGIN = 'https://maps.iag.bg';

    const fix = (url) => (typeof url === 'string' ? url.replace(BAD_ORIGIN, GOOD_ORIGIN) : url);
    const needsFix = (s) => typeof s === 'string' && s.search(BAD_ORIGIN) !== -1;
    const fixDeep = (obj) => JSON.parse(fix(JSON.stringify(obj)));

    // 1) fetch: пренаписва URL на заявката и съдържанието на текстовите отговори (map config)
    const origFetch = window.fetch;
    window.fetch = async (input, init) => {
        if (typeof input === 'string' || input instanceof URL) {
            input = fix(String(input));
        } else if (input instanceof Request && needsFix(input.url)) {
            input = new Request(fix(input.url), input);
        }
        const res = await origFetch(input, init);
        const type = res.headers.get('content-type') || '';
        if (!/json|text|xml/.test(type)) return res;
        const body = await res.clone().text();
        if (!needsFix(body)) return res;
        return new Response(fix(body), { status: res.status, statusText: res.statusText, headers: res.headers });
    };

    // 2) XHR (axios в MapStore): URL на заявката + отговорите
    const XHR = XMLHttpRequest.prototype;
    const origOpen = XHR.open;
    XHR.open = function (method, url, ...rest) {
        return origOpen.call(this, method, fix(String(url)), ...rest);
    };

    const textDesc = Object.getOwnPropertyDescriptor(XHR, 'responseText');
    const respDesc = Object.getOwnPropertyDescriptor(XHR, 'response');
    Object.defineProperty(XHR, 'responseText', {
        configurable: true,
        get() {
            return fix(textDesc.get.call(this));
        },
    });
    Object.defineProperty(XHR, 'response', {
        configurable: true,
        get() {
            const r = respDesc.get.call(this);
            if (typeof r === 'string') return fix(r);
            if (this.responseType === 'json' && r && needsFix(JSON.stringify(r))) return fixDeep(r);
            return r;
        },
    });

    // 3) Резервен вариант: плочки/легенди, зададени директно като <img src>
    const imgSrc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
        configurable: true,
        enumerable: imgSrc.enumerable,
        get() {
            return imgSrc.get.call(this);
        },
        set(value) {
            imgSrc.set.call(this, fix(value));
        },
    });

    const origSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
        if (name === 'src' || name === 'href') value = fix(value);
        return origSetAttribute.call(this, name, value);
    };
})();
