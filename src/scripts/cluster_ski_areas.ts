import clusterSkiAreas from "../clustering/ClusterSkiAreas";
import { configFromEnvironment } from "../Config";
import { getPostGISDataStore } from "../io/PostGISDataStore";

const config = configFromEnvironment();
const dataStore = getPostGISDataStore(config.postgresCache);

clusterSkiAreas(dataStore, config);
