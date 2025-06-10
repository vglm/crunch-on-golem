/**
 * This example demonstrates how to scan the market for providers that meet specific requirements.
 */
import {GolemNetwork, sleep} from "@golem-sdk/golem-js";
import {filter, last, map, scan, switchMap, take, takeUntil, tap, timer} from "rxjs";
import dotenv from 'dotenv';
import axios from "axios";

dotenv.config();

const ONE_PASS_TIME = parseInt(process.env.ONE_PASS_TIME ?? "60");
const NUMBER_OF_PASSES =  parseInt(process.env.NUMBER_OF_PASSES ?? "10");
const PASS_EVERY_SECONDS =  parseInt(process.env.PASS_EVERY_SECONDS ?? "30");
const CRUNCHER_VERSION = process.env.CRUNCHER_VERSION ?? "prod-12.4.1";
const CRUNCHER_ALLOCATION = parseFloat(process.env.CRUNCHER_ALLOCATION ?? "0.04");

//get from env
const UPLOAD_URL_BASE = process.env.UPLOAD_URL_BASE ?? "https://addressology.net";

function sleep_secs(seconds) {
    return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}

async function openJob(requestorId, provNodeId, provRewardAddr, provName, provExtraInfo) {
    let createJob = {
        "miner": {
            "provNodeId": provNodeId,
            "provRewardAddr": provRewardAddr,
            "provName": provName,
            "provExtraInfo": provExtraInfo
        },
        "cruncherVer": CRUNCHER_VERSION,
        "requestorId": requestorId
    }

    const response = await axios.post(`${UPLOAD_URL_BASE}/api/job/new`, createJob, {
        headers: {
            'Content-Type': 'application/json',
        },
    });
    const data = response.data;
    console.log(data);

    return data.uid;
}

async function closeJob(jobId) {
    const response = await axios.post(`${UPLOAD_URL_BASE}/api/job/finish/${jobId}`, {
        headers: {
            'Content-Type': 'application/json',
        },
    });

    const data = response.data;
    console.log(data);
    return data;
}

async function updateJob(jobId, upload_many, reportedHashes, reportedCost) {
    let update = {
        "extra": {
            "jobId": jobId,
            "reportedHashes": reportedHashes,
            "reportedCost": reportedCost
        },
        "data": upload_many
    };
    console.log(upload_many);

    let body = JSON.stringify(update);
    console.log("Update data size: " + body.length + " Total compute: " + reportedHashes);
    const response = await axios.post(`${UPLOAD_URL_BASE}/api/fancy/new_many`, update, {
        headers: {
            'Content-Type': 'application/json',
        },
    });

    const data = response.data;
    return data;
}

function timeout(ms) {
    return new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)
    );
}

(async () => {

    const glm = new GolemNetwork();

    const RENTAL_DURATION_HOURS = (ONE_PASS_TIME * NUMBER_OF_PASSES) / 3600 + 0.1;
    const ALLOCATION_DURATION_HOURS = RENTAL_DURATION_HOURS + 0.1;

    console.assert(
        ALLOCATION_DURATION_HOURS > RENTAL_DURATION_HOURS,
        "Always create allocations that will live longer than the planned rental duration",
    );

    let allocation;
    try {
        await glm.connect();

        console.log("Allocation duration: ", ALLOCATION_DURATION_HOURS, " hours");
        console.log("Rental duration: ", RENTAL_DURATION_HOURS, " hours");
        // Define the order that we're going to place on the market

        const allocation = await glm.payment.createAllocation({
            budget: CRUNCHER_ALLOCATION,
            expirationSec: Math.round(ALLOCATION_DURATION_HOURS * 3600),
            paymentPlatform: 'erc20-holesky-tglm'
        });
        const requestorIdentity = allocation.address;
        const order = {
            demand: {
                workload: {
                    imageTag: `nvidia/cuda-x-crunch:${CRUNCHER_VERSION}`,
                    capabilities: [],
                    engine: "dummy",
                },
            },
            market: {
                rentHours: RENTAL_DURATION_HOURS,
                pricing: {
                    model: "linear",
                    maxStartPrice: 0.0,
                    maxCpuPerHourPrice: 0.0,
                },
            },
            payment: {
                allocation,
            },
        };
        // Allocate funds to cover the order, we will only pay for the actual usage
        // so any unused funds will be returned to us at the end

        // Convert the human-readable order to a protocol-level format that we will publish on the network
        const demandSpecification = await glm.market.buildDemandDetails(order.demand, order.market, allocation);

        // Publish the order on the market
        // This methods creates and observable that publishes the order and refreshes it every 30 minutes.
        // Unsubscribing from the observable will remove the order from the market
        const demand$ = glm.market.publishAndRefreshDemand(demandSpecification);

        // Now, for each created demand, let's listen to proposals from providers
        const offerProposal$ = demand$.pipe(
            switchMap((demand) => glm.market.collectMarketProposalEvents(demand)),
            // to keep things simple we don't care about any other events
            // related to this demand, only proposals from providers
            filter(event => event.type === "ProposalReceived"),
            map(event => {
                console.log("Received proposal from provider", event.proposal.provider.name);
                return event.proposal
            })
        );

        // Each received proposal can be in one of two states: initial or draft
        // Initial proposals are the first ones received from providers and require us to respond with a counter-offer
        // Draft proposals are the ones that we have already negotiated and are ready to be accepted
        // Both types come in the same stream, so let's write a handler that will respond to initial proposals
        // and save draft proposals for later
        const draftProposals = [];
        const offerProposalsSubscription = offerProposal$.subscribe((offerProposal) => {
            if (offerProposal.isInitial()) {
                // here we can define our own counter-offer
                // to keep this example simple, we will respond with the same
                // specification as the one we used to publish the demand
                // feel free to modify this to your needs
                glm.market.negotiateProposal(offerProposal, demandSpecification).catch(console.error);
            } else if (offerProposal.isDraft()) {
                draftProposals.push(offerProposal);
            }
        });

        // Let's wait for a couple seconds to receive some proposals
        while (draftProposals.length < 1) {
            console.log("Waiting for proposals...");
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }


        // We have received at least one draft proposal, we can now stop listening for more
        offerProposalsSubscription.unsubscribe();

        const draftProposal = draftProposals[0];

        console.log("Received proposal", draftProposal);

        const agreement = await glm.market.proposeAgreement(draftProposal);
        console.log("Agreement signed with provider", agreement.provider.name);

        // Provider is ready to start the computation
        // Let's setup payment first
        // As the computation happens, we will receive debit notes to inform us about the cost
        // and an invoice at the end to settle the payment
        const invoiceSubscription = glm.payment
            .observeInvoices()
            .pipe(
                // make sure we only process invoices related to our agreement
                filter((invoice) => invoice.agreementId === agreement.id),
                // end the stream after we receive an invoice
                take(1),
            )
            .subscribe((invoice) => {
                console.log("Received invoice for ", invoice.getPreciseAmount().toFixed(4), "GLM");
                glm.payment.acceptInvoice(invoice, allocation, invoice.amount).catch(console.error);
            });
        const debitNoteSubscription = glm.payment
            .observeDebitNotes()
            .pipe(
                // make sure we only process invoices related to our agreement
                filter((debitNote) => debitNote.agreementId === agreement.id),
            )
            .subscribe((debitNote) => {
                console.log("Received debit note for ", debitNote.getPreciseAmount().toFixed(4), "GLM");
                glm.payment.acceptDebitNote(debitNote, allocation, debitNote.totalAmountDue).catch(console.error);
            });

        // Start the computation
        // First lets start the activity - this will deploy our image on the provider's machine
        const activity = await glm.activity.createActivity(agreement);
        // Then let's create a ExeUnit, which is a set of utilities to interact with the
        // providers machine, like running commands, uploading files, etc.


        const exe = await glm.activity.createExeUnit(activity);

        console.log("Exe unit created")

        const jobId = await openJob(
            requestorIdentity,
            agreement.provider.id,
            agreement.provider.walletAddress,
            agreement.provider.name,
            "extra"
        );
        console.log("Job opened")

        let promises = [];
        let totalJobComputed = 0;
        let jobScore = 0.0;
        const factory = "0x9E3F8eaE49E442A323EF2094f277Bf62752E6995";
        {
            let res = await exe.run("set_work_target", ["factory", factory]);

            if (res.result !== "Ok") {
                console.log(`Command set_work_target failed with message: ${res.message}`);
                throw `Command set_work_target failed with message: ${res.message}`;
            }
        }

        {
            let res = await exe.run("start_work", []);

            if (res.result !== "Ok") {
                console.log(`Command start_work failed with message: ${res.message}`);
                throw `Command start_work failed with message: ${res.message}`;
            }
        }

        for (let passNo = 0; passNo < NUMBER_OF_PASSES; passNo++) {
            let res = await exe.run("set_hash_and_take_results", [(jobScore / 1e12).toFixed(2)]);

            if (res.result !== "Ok") {
                console.log(`Command take_results failed with message: ${res.message}`);
                throw `Command take_results failed with message: ${res.message}`;
            }
            let message = res.stdout;
            console.log("Received message: " + message);

            {
                //check message length
                if (message.length % 32 !== 0) {
                    console.log(`Received wrong message length: ${res.message.length}, Should be multiple of 32`);
                    throw "Received wrong message length: ${res.message.length}, Should be multiple of 32";
                }
                const multipleResults = [];
                for (let place = 0; place < message.length; place += 32) {
                    let salt = message.slice(place, place + 32);
                    multipleResults.push({
                        "salt": '0x' + [...salt].map(b => b.toString(16).padStart(2, '0')).join(''),
                        "address": null,
                        "factory": factory
                    });
                }
                if (multipleResults.length > 0) {
                    let data = await updateJob(jobId, multipleResults, totalJobComputed, 0);

                    //console.log(`Uploaded addresses - received ${JSON.stringify(data)}`);
                    jobScore += data['totalScore'];

                }
            }

            await sleep_secs(PASS_EVERY_SECONDS);
            {
                //const thJobScore = jobScore / 1e12;

                //const thJobScoreStr =
                //console.log("Updating job score with value: " + jobScore);
                //let _res = await exe.run("set_hash", [thJobScore]);

            }

        }

        {
            let res = await exe.run("stop_work", []);

            if (res.result !== "Ok") {
                console.log(`Command start_work failed with message: ${res.message}`);
                throw `Command start_work failed with message: ${res.message}`;
            }
        }

        // We're done, let's clean up provider
        // First we need to destroy the activity
        await glm.activity.destroyActivity(activity)
        await glm.market.terminateAgreement(agreement);


        //finish uploading jobs to the server if any pending
        await Promise.all(promises);
        await closeJob(jobId);


        invoiceSubscription.unsubscribe();
        debitNoteSubscription.unsubscribe();

        if (allocation) {
            await glm.payment.releaseAllocation(allocation);
        }
        await glm.disconnect();
    } catch (err) {
        if (allocation) {
            await glm.payment.releaseAllocation(allocation);
        }
        await glm.disconnect();
        throw err;
    }

})();