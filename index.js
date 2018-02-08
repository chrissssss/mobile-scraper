/**
 * The MIT License (MIT)
 *
 * Copyright (c) <2015> Dominik Winter <info at edge-project.org>
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

const fs = require('fs');
const cheerio = require('cheerio');
const async = require('async');
const Excel = require('exceljs');

const { models, options } = require('./config/search');
const l10n = require('./config/l10n')[options.language];
const headers = require('./config/headers')(l10n.browser_language);
const cacheDir = `./.cache_${options.language}`;

const requestRaw = require('request');
const request = requestRaw.defaults({
    jar: true,
    gzip: true,
    followAllRedirects: true,
    headers: headers,
});

const templasteSearchUrl = l10n.url.search + Object.keys(options).map(name =>
    [].concat(options[name]).map(value =>
        `${name}=${value}`
    ).join('&')
).join('&');

const handleError = (err, cb) => { if (err) { typeof cb === 'function' && cb(); throw err; } };
const idOf = i => (i >= 26 ? idOf((i / 26 >> 0) - 1) : '') + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.substr([i % 26 >> 0], 1);
const ifempty = (val, alt) => typeof val === 'undefined' ? alt : val;

const _getTechnical = $ => {
    const items = {};

    $('#rbt-td-box .g-row.u-margin-bottom-9').each((k, v) => {
        let key = $(v.children[0]).text().trim();
        let val = $(v.children[1]).text().trim();

        switch (key) {
            case l10n.mileage:              key += ' (km)';     val = val.replace(/[^\d]/g, '') * 1;        break;
            case l10n.power:                key += ' (PS)';     val = val.match(/(\d+)\s+PS/)[1] * 1;       break;
            case l10n.first_registration:                       val = val.split('/').reverse().join('-');   break;
        }

        items[key] = val;
    })

    return items;
};

const _getFeatures = $ => {
    const items = {};

    $('#rbt-features p').each((k, v) => {
        const key = $(v).text().trim();
        const val = 'X';

        items[key] = val;
    })

    return items;
};

const generateKeyList = (data, name) => {
    const list = new Set;

    data.forEach(items => Object.keys(items[name]).map(key => list.add(key)));

    return [...list];
};

const _handleData = data => {
    console.info('Cars found:', data.length);

    const possible_technical = generateKeyList(data, 'technical');
    const possible_features  = generateKeyList(data, 'features');

    const workbook = new Excel.Workbook();
    const worksheet = workbook.addWorksheet('My Sheet', {
        views: [
            { xSplit: 1, ySplit: 1, zoomScale: 80 }
        ]
    });

    const headers = [];

    // head
    Object.keys(data[0]).forEach(key => {
        switch (key) {
            case 'technical': return possible_technical.forEach(key => headers.push(key));
            case 'features':  return possible_features.forEach(key  => headers.push(key));
            default:          return headers.push(key);
        }
    });

    headers.push('sum');

    // TODO very ugly :/
    {
        const headerRow = worksheet.addRow(headers);
        let num = 0;

        Object.keys(data[0]).forEach(key => {
            switch (key) {
                case 'technical': return possible_technical.forEach(key => ++num);
                case 'features':  return possible_features.forEach(key  => headerRow.getCell(++num).alignment = { textRotation: 90 });
                default:          return ++num;
            }
        });
    }

    // data
    data.forEach((items, i) => {
        const row = [];
        let sum = '', cur = '';

        Object.keys(items).forEach(item => {
            switch (item) {
                case 'technical': return possible_technical.forEach((key) => row.push(ifempty(items[item][key], '')));
                case 'features':  return possible_features.forEach((key)  => { cur = ifempty(items[item][key], ''); sum += cur; row.push(cur); });
                default:          return row.push(items[item]);
            }
        });

        row.push(sum.length);

        worksheet.addRow(row)
/*
        const dataRow = worksheet.addRow(row);
        const start   = possible_technical.length;
        const end     = start + possible_features.length;

        ++i;

        const cell = dataRow.getCell(idOf(row.length))
        cell.value = { formula: '=COUNTIF(I' + i + ':AA' + i + ';"X")', result: 1 };
        cell.type = Excel.ValueType.Formula;

        dataRow.commit();
*/
    });

    workbook.xlsx.writeFile(`excel_${options.language}.xls`);

    console.info(`Output: excel_${options.language}.xls`);
};

const _parseResultPage = (url, cb) => {
    console.info('SEARCH GET', url)

    request(url, (err, response, html) => {
        handleError(err, () => console.error(err, response, html));

        const $ = cheerio.load(html);
        const currentLinks = [];

        $('a.link--muted.no--text--decoration.result-item').each((k, v) => currentLinks.push($(v).attr('href').match(/.+details.html\?id=(\d+)/).slice(0, 2)));

        const next = $('.rbt-page-forward').attr('data-href');

        if (next) {
            _parseResultPage(next, (links) => cb(links.concat(currentLinks)));
        } else {
            cb(currentLinks);
        }
    });
};

const _parseItemPage = (infos, next) =>
    async.mapLimit(infos, 2, (info, cb) => {
        const url  = info[0];
        const id   = info[1];
        const file = `${cacheDir}/${id}.json`;

        fs.access(file, err => {
            if (!err) return cb(); // file already exists

            console.info('CAR GET', url);

            request(url, (err, response, html) => {
                handleError(err, () => console.error(err, response, html));

                const $ = cheerio.load(html);

                $('.tooltip-wrapper').remove();

                try {
                    fs.writeFile(file, JSON.stringify({
                        'id': id * 1,
                        'title': $('#rbt-ad-title').text().trim(),
                        //'dealer_name': $('#dealer-hp-link-bottom').text().trim(),
                        //'dealer_address': $('#rbt-db-address').text().trim(),
                        //'dealer_phone': $('#rbt-db-phone').text().trim(),
                        //'dealer_no': $('#rbt-db-sku b').text().trim(),
                        'price': $('.rbt-prime-price').text().replace(/[^\d]/g, '').trim() * 1,
                        'technical': _getTechnical($),
                        'features': _getFeatures($)
                    }, null, 4), err => {
                        err && console.error(`Couldn't write file ${file}:`, err);
                        cb();
                    });
                } catch (err) {
                    console.error(`Couldn't write file ${file}:`, err);
                    cb();
                }
            });
        });
    }, next)
;

fs.existsSync(cacheDir) || fs.mkdirSync(cacheDir);

request(l10n.url.start, (err, response, html) => {
    handleError(err);

    async.mapLimit(models, 2, (model, cb) => {
        let url = templasteSearchUrl
            .replace('#makeId#',  model[0])
            .replace('#modelId#', model[1])
        ;

        if (model[2]) {
            url += '&makeModelVariant1.modelDescription=' + model[2];
        }

        _parseResultPage(url, links => _parseItemPage(links, cb));
    }, () => {
        fs.readdir(cacheDir, (err, items) => {
            const data = [];

            items.forEach((item) => {
                try {
                    const entry = JSON.parse(fs.readFileSync(`${cacheDir}/${item}`, 'utf8'));

                    Object.keys(entry.technical).forEach((name) => {
                        if (l10n.technical_excludes.indexOf(name) > -1) {
                            delete entry.technical[name];
                        }
                    });

                    Object.keys(entry.features).forEach((name) => {
                        if (l10n.features_excludes.indexOf(name) > -1) {
                            delete entry.features[name];
                        }
                    });

                    data.push(entry);
                } catch (err) {
                    console.error(`Couldn't load file ${cacheDir}/${item}.`, err);
                }
            });

            if (data.length) {
                _handleData(data);
            } else {
                console.info('nothing to do');
            }
        });
    });
});
