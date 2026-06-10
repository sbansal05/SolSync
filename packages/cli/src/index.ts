#!/usr/bin/env node

import {Command} from "commander";
import { registerAnalyze} from "./commands/analyze";

const program  = new Command();

program
    .name("solsync")
    .description("Dynamic Priority Fee & Compute Bughet Optimization Engine")
    .version("0.0.1");

registerAnalyze(program);

program.parse(process.argv);