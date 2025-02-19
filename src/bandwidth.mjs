import { GolemNetwork } from "@golem-sdk/golem-js";
import { pinoPrettyLogger } from "@golem-sdk/pino-logger";
import axios from "axios";
import dotenv from 'dotenv';

dotenv.config();

const ONE_PASS_TIME = parseInt(process.env.ONE_PASS_TIME ?? "60");
const NUMBER_OF_PASSES =  parseInt(process.env.NUMBER_OF_PASSES ?? "10");
const CRUNCHER_VERSION = process.env.CRUNCHER_VERSION ?? "prod-12.4.1";

//get from env
const UPLOAD_URL_BASE = process.env.UPLOAD_URL_BASE ?? "https://addressology.ovh";

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

    let body = JSON.stringify(update);
    console.log("Update data size: " + body.length + " Total compute: " + reportedHashes);
    const response = await axios.post(`${UPLOAD_URL_BASE}/api/fancy/new_many2`, update, {
        headers: {
            'Content-Type': 'application/json',
        },
    });

    const data = response.data;
    console.log(data);
    return data;
}

function timeout(ms) {
    return new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)
    );
}

(async () => {
    /*while(true)*/ {
        const glm = new GolemNetwork({
            logger: pinoPrettyLogger({
                level: "info",
            }),
            api: {
                key: "66iiOdkvV29",
                //key: "cae73410a3b54415b13750d0b6ae9cba",
            },
        });

        const allocation = await glm.payment.createAllocation({
            budget: 1,
            expirationSec: 60*20,
            paymentPlatform: 'erc20-polygon-glm'
        });
        const requestorIdentity = allocation.address;

        const order = {
            demand: {
                workload: {
                    imageTag: `nvidia/cuda-x-crunch:${CRUNCHER_VERSION}`,
                    capabilities: ["!exp:gpu"],
                    engine: "vm-nvidia",
                },
            },
            market: {
                rentHours: 0.2,
                pricing: {
                    model: "linear",
                    maxStartPrice: 0.0,
                    maxCpuPerHourPrice: 0.0,
                    maxEnvPerHourPrice: 2.0,
                },
            },
            payment: {
                allocation,
            },
        };

        try {
            await glm.connect();
            const rental = await Promise.race([
                glm.oneOf({ order }),
                timeout(60000) // 60 seconds timeout
            ]);

            const jobId = await openJob(
                requestorIdentity,
                rental.agreement.provider.id,
                rental.agreement.provider.walletAddress,
                rental.agreement.provider.name,
                "extra"
            );
            const exe = await rental.getExeUnit();
            await exe.run('chmod +x /usr/local/bin/profanity_cuda')
                .then((res) => {

                    console.log(res)
                });
            await exe.run('nvidia-smi')
                .then((res) => {
                    console.log(res)
                });

            let promises = [];
            let totalJobComputed = 0;
            for (let passNo = 0; passNo < NUMBER_OF_PASSES; passNo++) {
                await exe.run(`profanity_cuda -b ${ONE_PASS_TIME}`)
                    .then(async (res) => {
                        const multipleResults = [];

                        let biggestCompute = 0;
                        for (let line of res.stderr.split('\n')) {
                            console.log(line);
                            if (line.includes('Total compute')) {
                                try {
                                    const totalCompute = line.split('Total compute ')[1].trim().split(' GH')[0];
                                    const totalComputeFloatGh = parseFloat(totalCompute);
                                    biggestCompute = totalComputeFloatGh * 1e9;
                                    //console.log("Total compute: " + totalCompute);
                                } catch (e) {
                                    console.error(e);
                                }
                            }
                        }
                        totalJobComputed += biggestCompute;

                        for (let line of res.stdout.split('\n')) {
                            try {
                                line = line.trim();
                                if (line.startsWith('0x')) {
                                    const salt = line.split(',')[0];
                                    const addr = line.split(',')[1];
                                    const factory = line.split(',')[2];
                                    multipleResults.push({
                                        "salt": salt,
                                        "address": addr,
                                        "factory": factory
                                    });
                                }
                            } catch (e) {
                                console.error(e);
                            }
                        }
                        promises.push(updateJob(jobId, multipleResults, totalJobComputed, 0));
                    });

            }
            await Promise.all(promises);
            await rental.stopAndFinalize();


            await closeJob(jobId);
        } catch (err) {
            console.error("Failed to run the example", err);
        } finally {
            await glm.payment.releaseAllocation(allocation);
            await glm.disconnect();
        }
    }

})().catch(console.error);
