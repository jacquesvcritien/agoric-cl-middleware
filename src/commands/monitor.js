import { Command } from 'commander';
import { inspect } from 'util';
import {
    boardSlottingMarshaller,
    makeRpcUtils,
    storageHelper,
    networkConfig
} from '../lib/rpc.js';
import {
    makeFollower,
    makeLeader,
} from '@agoric/casting';
import { coalesceWalletState } from '@agoric/smart-wallet/src/utils.js';
import { validUrl, readJSONFile, readFile, saveJSONDataToFile } from './helper.js'
import { getCurrent } from '../lib/wallet.js';
import { Registry, Gauge } from 'prom-client';
import { createServer } from 'http';
import { parse } from 'url';

const { PORT = '3001', POLL_INTERVAL = '10', AGORIC_NET, AGORIC_RPC = "http://0.0.0.0:26657" } = process.env;
assert(!isNaN(Number(PORT)), '$PORT is required');
assert(!isNaN(Number(POLL_INTERVAL)), '$POLL_INTERVAL is required');
assert(validUrl(AGORIC_RPC), '$AGORIC_RPC is required');
assert(AGORIC_NET != "" && AGORIC_NET != null, '$AGORIC_NET is required');

// Create a Registry which registers the metrics
const register = new Registry()

// Add a default label which is added to all metrics
register.setDefaultLabels({
    app: 'agoric-cl-oracle-monitor'
})

//Create gauge for value
const oracleSubmission = new Gauge({
    name: 'oracle_latest_value',
    help: 'Latest value submitted by oracle',
    labelNames: ['oracleName', 'oracle', 'feed']
})

//Create gauge for timestamp
const oracleObservation = new Gauge({
    name: 'oracle_last_observation',
    help: 'Last epoch in which oracle made an observation',
    labelNames: ['oracleName', 'oracle', 'feed']
})

//Create gauge for last round
const oracleLastRound = new Gauge({
    name: 'oracle_last_round',
    help: 'Last round in which oracle made an observation',
    labelNames: ['oracleName', 'oracle', 'feed']
})

//Create gauge for price deviation
const oracleDeviation = new Gauge({
    name: 'oracle_price_deviation',
    help: 'Latest price deviation by oracle',
    labelNames: ['oracleName', 'oracle', 'feed']
})

//Create gauge for balance
const oracleBalance = new Gauge({
    name: 'oracle_balance',
    help: 'Oracle balances',
    labelNames: ['oracleName', 'oracle', 'brand']
})

//Create gauge for last price
const actualPrice = new Gauge({
    name: 'actual_price',
    help: 'Actual last price from feed',
    labelNames: ['feed']
})

// Register the gaugex
register.registerMetric(oracleSubmission)
register.registerMetric(oracleObservation)
register.registerMetric(oracleLastRound)
register.registerMetric(oracleBalance)
register.registerMetric(oracleDeviation)
register.registerMetric(actualPrice)

const { agoricNames, fromBoard, vstorage } = await makeRpcUtils({ fetch });

//this holds the offer ids
var feeds = []
//this holds the amounts in
var amountsIn = {}

const { 
    STATE_FILE = "data/monitoring_state.json",
    ORACLE_FILE= "config/oracles.json",
  } = process.env;

/**
 * Function to read oracles
 * @returns oracles, their names and their addresses
 */
const readOracleAddresses = () => {
    var oracles = readJSONFile(ORACLE_FILE)
    return oracles
}

/**
 * Function to get oracles feed invitations
 */
export const getOraclesInvitations = async () => {
    //get the feeds
    feeds = agoricNames.reverse

    //for each oracle
    for (let oracle in oracles){

        const current = await getCurrent(oracle, fromBoard, { vstorage });
        const invitations = current.offerToUsedInvitation

        //for each invitation
        for (let inv in invitations) {
            let boardId = invitations[inv].value[0].instance.boardId
            let feed = feeds[boardId].split(" price feed")[0]

            if (!("feeds" in oracles[oracle])) {
                oracles[oracle]["feeds"] = {}
            }
            //add feed
            oracles[oracle]["feeds"][String(inv)] = feed
        }
    }
}

//var oracleLabels = readOracles();
var oracles = readOracleAddresses();
await getOraclesInvitations();

/**
 * Function to update metrics
 * @param {*} oracleName oracle name
 * @param {*} oracle oracle address
 * @param {*} feed feed name
 * @param {*} value new feed value
 * @param {*} id submission id which is a timestamp
 * @param {*} actualPrice feed actual aggregated price
 * @param {*} lastRound latest round id for which there was a submission
 */
const updateMetrics = (oracleName, oracle, feed, value, id, actualPrice, lastRound) => {
    //calculate price deviation from actual value
    let priceDeviation = Math.abs((value - actualPrice) / actualPrice) * 100

    oracleSubmission.labels(oracleName, oracle, feed).set(value)
    oracleObservation.labels(oracleName, oracle, feed).set(id)
    oracleLastRound.labels(oracleName, oracle, feed).set(lastRound)
    oracleDeviation.labels(oracleName, oracle, feed).set(priceDeviation)
    actualPrice.labels(feed).set(actualPrice)
}

/**
 * Function to update balance metrics
 * @param {*} oracleName oracle name
 * @param {*} oracle oracle address
 * @param {*} feed feed
 * @param {*} value balance value to set
 */
const updateBalanceMetrics = (oracleName, oracle, feed, value) => {
    oracleBalance.labels(oracleName, oracle, feed).set(value)
}

/**
 * Function to query price for feed
 * @param {*} jobName feed like 'BRAND_IN-BRAND_OUT'
 * @returns the price of the feed
 */
const queryPrice = async (jobName) => {
    const capDataStr = await vstorage.readLatest(
        `published.priceFeed.${jobName}_price_feed`,
    );

    //parse the value
    var capData = JSON.parse(JSON.parse(capDataStr).value)
    capData = JSON.parse(capData.values[0])
    //replace any extra characters
    capData = JSON.parse(capData.body.replaceAll("\\", ""))

    //get the latest price by dividing amountOut by amountIn
    var latestPrice = Number(capData.amountOut.value.digits) / Number(capData.amountIn.value.digits)
    amountsIn[jobName] = Number(capData.amountIn.value.digits)

    console.log(jobName + " Price Query: " + String(latestPrice))
    actualPrice.labels(jobName).set(latestPrice)
    return latestPrice
}

/**
 * Function to get latest prices for oracle
 * @param {*} oracle oracle address
 * @param {*} oracleDetails oracle details
 * @param {*} lastIndex last offer index from offers
 * @returns last results including the oracle submitted price
 */
export const getLatestPrices = async (oracle, oracleDetails, lastIndex) => {

    //get feeds for oracle
    let feeds = oracleDetails["feeds"]
    console.log("Getting prices for", oracle, feeds)

    const unserializer = boardSlottingMarshaller(fromBoard.convertSlotToVal);
    const leader = makeLeader(networkConfig.rpcAddrs[0]);

    const follower = await makeFollower(
        `:published.wallet.${oracle}`,
        leader,
        {
            // @ts-expect-error xxx
            unserializer,
        },
    );
    const coalesced = await coalesceWalletState(follower);

    //get offers
    let offers = Array.from(coalesced.offerStatuses.values());
    //get balance
    let balances = Array.from(coalesced.balances.values());

    //initialise variable to hold results
    let lastResults = {
        "last_index": lastIndex,
        "values": {}
    }

    //get last offer index
    lastIndex = (lastIndex > offers.length) ? 0 : lastIndex;

    //loop through offers starting from last visited index
    for (var i = lastIndex; i < offers.length; i++) {
        //get current offer
        var currentOffer = offers[i];
        lastResults["last_index"] = i;

        //if a price invitatio
        if (currentOffer["invitationSpec"]["invitationMakerName"] == "PushPrice") {
            let feed = feeds[currentOffer["invitationSpec"]["previousOffer"]]
            let price = Number(currentOffer["invitationSpec"]["invitationArgs"][0]["unitPrice"]) / amountsIn[feed]
            let lastRound = Number(currentOffer["invitationSpec"]["invitationArgs"][0]["roundId"])
            let id = Number(currentOffer["id"])

            //fill results variable
            lastResults["values"][feed] = {
                price: price,
                id: id,
                round: lastRound
            }

            //get latest feed price
            let feedPrice = await queryPrice(feed)
            //update metrics
            updateMetrics(oracleDetails["oracleName"], oracle, feed, price, id, feedPrice, lastRound)
        }
    }

    //loop through balances
    for (var i = 0; i < balances.length; i++) {
        let currentBalance = balances[i]
        var brand = currentBalance.brand.iface.split(" ")[1]
        if (brand.includes("BLD") || brand.includes("IST")) {
            var value = Number(currentBalance.value)
            updateBalanceMetrics(oracleDetails["oracleName"], oracle, brand, value)
        }
    }

    return lastResults
}

/**
 * Function to read the latest monitoring state from file
 * @returns latest monitoring state
 */
const readMonitoringState = () => {
    //try to read from file
    try{
        return readJSONFile(STATE_FILE)
    } catch(err) {
        //if it fails, initialise and save
        let initialState = {}

        for (let oracle in oracles) {
            initialState[oracle] = {
                "last_index": 0,
                "values": {}
            }
        }

        //save to file
        saveJSONDataToFile(initialState, STATE_FILE)
        return initialState
    }
}

/**
 * Main function to monitor
 */
export const monitor = async () => {

    //read monitoring state or initialise
    let state = readMonitoringState()

    //create interval
    setInterval(async () => {

        //for each oracle
        for (let oracle in oracles) {

            //check if there is state for oracle
            if (!(oracle in state)) {
                state[oracle] = {
                    "last_index": 0,
                    "values": {}
                }
            }
            console.log("ORACLE STATE", state[oracle])

            //get latest prices for oracle
            let latestOracleState = await getLatestPrices(oracle, oracles[oracle], state[oracle]["last_index"])
            state[oracle] = latestOracleState
        }

        //update state
        saveJSONDataToFile(state, STATE_FILE)

    }, POLL_INTERVAL * 1000);
}

/**
 * Creates the server for the metrics endpoint
 */
const startServer = () => {
    // Define the HTTP server
    const server = createServer(async (req, res) => {

        // Retrieve route from request object
        const route = parse(req.url).pathname

        if (route === '/metrics') {
            // Return all metrics the Prometheus exposition format
            res.setHeader('Content-Type', register.contentType)
            res.end(await register.metrics())
        }
    });

    server.listen(PORT)

}

startServer()
