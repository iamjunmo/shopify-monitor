const request = require('request');
const moment = require('moment');
const chalk = require('chalk');
const cheerio = require('cheerio');
const xml2js = require('xml2js');
const _ = require('underscore');
const log = require('./utils/log');
const config = require('./config');
const fs = require('fs');
const db = require('knex')(config.database);
var events = require('./events');

var checkCount = 0;
var productCount = 0;

const proxyInput = fs.readFileSync('proxies.txt').toString().split('\n');
const proxyList = [];

function formatProxy(proxy) {
    if (proxy && ['localhost', ''].indexOf(proxy) < 0) {
        proxy = proxy.replace(' ', '_');
        const proxySplit = proxy.split(':');
        if (proxySplit.length > 3)
            return "http://" + proxySplit[2] + ":" + proxySplit[3] + "@" + proxySplit[0] + ":" + proxySplit[1];
        else
            return "http://" + proxySplit[0] + ":" + proxySplit[1];
    } else
        return undefined;
}

function getProxy() {
    if (!config.proxies) {
        return null;
    } else {
        return formatProxy(proxyInput[Math.floor(Math.random() * proxyInput.length)]);
    }
}

for (let p = 0; p < proxyInput.length; p++) {
    proxyInput[p] = proxyInput[p].replace('\r', '').replace('\n', '');
    if (proxyInput[p] != '')
        proxyList.push(proxyInput[p]);
}

// TODO: Keywords

var init = function(og, siteName, firstRun) {

    // TODO: Check if site is valid shopify site bychecking xml patttern

    const url = siteName + '/sitemap_products_1.xml';
    var proxy = getProxy();

    //console.log(`${url} - ${proxy}`);

    request({
        method: 'get',
        url: url,
        proxy: proxy,
        gzip: true,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3107.4 Safari/537.36'
        }
    }, (err, resp, body) => {

        if (err) {
            log(chalk.bgBlack.red(`Connection Error @ ${siteName}, polling again in ${config.pollTimeMs}ms`));
            if (firstRun) {
                return finalizeCheck(false);
            } else {
                return finalizeCheck(true);
            }
            //console.log(err)
        }

        if (body.includes('Try again in a couple minutes by refreshing the page.')) {
            // soft banned
            console.log(`Banned. Trying again in ${config.pollTimeMs}ms - ${url}`);
            return finalizeCheck(false);
        }

        const parsed = xml2js.parseString(body, (err, result) => {

            if (err) {
                const timeStamp = new Date().toString();

                fs.writeFile(`./logs/${og}_${timeStamp}.err`, body, (err) => {
                    if (err) {
                        console.log('Error saving log to file.');
                    } else {
                        console.log(`Wrote response data to ./logs/${timeStamp}.err`);
                    }
                });

                log(chalk.bgBlack.red(`Parsing Error @ ${siteName}, polling again in ${config.pollTimeMs}ms`));
                if (firstRun) {
                    return finalizeCheck(false);
                } else {
                    return finalizeCheck(true);
                }
            }

            if (result == undefined || result == null) {
                return finalizeCheck(false);
            }

            const products = result['urlset']['url'];

            if (products == undefined || products == null) {
                return finalizeCheck(false);
            }

            productCount = products.length;

            if (productCount <= 1) {
                return finalizeCheck(true);
            }

            var queryPromises = [];
            var queryURLs = [];
            var insertPromises = [];
            var updatePromises = [];

            if (firstRun) {
                for (var i = 0; i < products.length; i++) {
                    if (i != 0) {
                        insertPromises.push(db.table('products').insert({
                            'site': og,
                            'productURL': products[i].loc[0],
                            'lastmod': products[i].lastmod[0]
                        }));
                    }
                }
                Promise.all(insertPromises).then((ret) => {
                    return finalizeCheck(true);
                }).catch((e) => {
                    console.log('err', e);
                });
            } else {
                persistentRun(products);
            }

            function persistentRun(products) {
                for (var i = 0; i < products.length; i++) {
                    if (i != 0) {
                        queryPromises.push(db('products').where({
                            productURL: products[i].loc[0]
                        }).first());
                    }
                }

                Promise.all(queryPromises).then((ret) => {
                    execPersistent(ret);
                }).catch((e) => {
                    console.log('err', e);
                });


                function execPersistent(ret) {

                    var finalPromises = [];

                    for (var i = 0; i < ret.length; i++) {

                        /* Check if its actually a new item (seeing if it doessnt exist in database)
                        by seeing SQLIte3 File for testing */

                        if (ret[i] == null) {

                            events.emit('newItem', {
                                url: products[i + 1].loc,
                                base: og
                            });

                            finalPromises.push(db.table('products').insert({
                                'site': og,
                                'productURL': products[i + 1].loc[0],
                                'lastmod': products[i + 1].lastmod[0]
                            }));

                        } else {

                            var compare = products.find(function(o) {
                                return o.loc[0] == [ret[i].productURL];
                            });

                            if (ret[i].productURL != compare.loc[0]) {

                                events.emit('restock', {
                                    url: products[i + 1].loc,
                                    base: og
                                });

                                // TODO: Update Database with latest mod!!!!

                                finalPromises.push(db('products').where({
                                    productURL: products[i + 1].loc
                                }).update({
                                    mod: products[i + 1].lastmod
                                }));

                            }

                        }

                    }

                    Promise.all(finalPromises).then((ret) => {
                        return finalizeCheck(true);
                    }).catch((e) => {
                        return finalizeCheck(true);
                    });

                }


            }


        });

        function finalizeCheck(successful) {

            if (successful) {
                if (firstRun) {
                    log(chalk.bgBlack.green(`Initial Check (Successful):  ${og}`));
                }
                return setTimeout(function() {
                    return init(og, siteName, false);
                }, config.pollTimeMs);
                checkCount++;

            } else {
                return setTimeout(function() {
                    return init(og, siteName, true);
                }, config.pollTimeMs);
                checkCount++;
            }

        }

    });
}

module.exports = {
    init: init
};
