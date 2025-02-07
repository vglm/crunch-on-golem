import { GolemNetwork } from "@golem-sdk/golem-js";
import { pinoPrettyLogger } from "@golem-sdk/pino-logger";



(async () => {

    while(true) {
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
            budget: 10,
            expirationSec: 3600,
            paymentPlatform: 'erc20-holesky-tglm'
        });

        const order = {
            demand: {
                workload: {
                    imageTag: "nvidia/cuda-x-crunch:prod-12.4.1",
                    capabilities: ["!exp:gpu"],
                    engine: "vm-nvidia",
                },
            },
            market: {
                rentHours: 0.5,
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
            const rental = await glm.oneOf({ order });
            const exe = await rental.getExeUnit();
            await exe.run('chmod +x /usr/local/bin/profanity_cuda')
                .then((res) => {

                    console.log(res)
                });
            for (let i = 0; i < 10; i++) {
                await exe.run('profanity_cuda -b 10')
                    .then((res) => {
                        for (let line of res.stdout.split('\n')) {
                            console.log(line)
                        }
                        console.log(res)
                    });
            }

            await rental.stopAndFinalize();
        } catch (err) {
            console.error("Failed to run the example", err);
        } finally {
            await glm.payment.releaseAllocation(allocation);
            await glm.disconnect();
        }
    }

})().catch(console.error);