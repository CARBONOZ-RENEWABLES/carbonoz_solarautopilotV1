
const width = 900;
const height = 600;

const svg = d3.select("#energy-flow-diagram")
    .append("svg")
    .attr("width", width)
    .attr("height", height);

    const nodes = [
{ id: "solar", label: "Solar", x: 300, y: 50 },
{ id: "grid", label: "Grid", x: 100, y: 200 },
{ id: "battery", label: "Battery", x: 300, y: 350 },
{ id: "home", label: "Home", x: 500, y: 200 }
];

const links = [
    { source: "solar", target: "battery" },
    { source: "solar", target: "home" },
    { source: "grid", target: "home" },
    { source: "grid", target: "battery" },
    { source: "battery", target: "home" },
    { source: "battery", target: "grid" },
    { source: "home", target: "grid" }
];

// Create links
const linkElements = svg.selectAll(".link")
    .data(links)
    .enter().append("path")
    .attr("class", "link")
    .attr("stroke", d => getColor(d.source, d.target))
    .attr("stroke-opacity", 0.6)
    .attr("stroke-width", 2);

// Create nodes
const nodeElements = svg.selectAll(".node")
    .data(nodes)
    .enter().append("g")
    .attr("class", "node")
    .attr("transform", d => `translate(${d.x},${d.y})`);

nodeElements.append("circle")
    .attr("r", 50)
    .attr("fill", "white")
    .attr("stroke", d => getNodeColor(d.id))
    .attr("stroke-width", 3);

nodeElements.append("path")
    .attr("d", d => getIconPath(d.id))
    .attr("fill", "black")
    .attr("transform", "translate(-25, -25) scale(0.1)");

nodeElements.append("text")
    .attr("class", "label")
    .attr("text-anchor", "middle")
    .attr("dy", "4em")
    .attr("fill", "black")
    .text(d => d.label);

const valueTexts = nodeElements.append("text")
    .attr("class", "value")
    .attr("text-anchor", "middle")
    .attr("dy", "5.5em")
    .attr("fill", "black");

function getNodeColor(id) {
    switch(id) {
        case "solar": return "orange";
        case "grid": return "lightblue";
        case "battery": return "pink";
        case "home": return "orange";
    }
}

function getIconPath(id) {
    switch(id) {
        case "solar":
            return "M361.5 1.2c5 2.1 8.6 6.6 9.6 11.9L391 121l107.9 19.8c5.3 1 9.8 4.6 11.9 9.6s1.5 10.7-1.6 15.2L446.9 256l62.3 90.3c3.1 4.5 3.7 10.2 1.6 15.2s-6.6 8.6-11.9 9.6L391 391 371.1 498.9c-1 5.3-4.6 9.8-9.6 11.9s-10.7 1.5-15.2-1.6L256 446.9l-90.3 62.3c-4.5 3.1-10.2 3.7-15.2 1.6s-8.6-6.6-9.6-11.9L121 391 13.1 371.1c-5.3-1-9.8-4.6-11.9-9.6s-1.5-10.7 1.6-15.2L65.1 256 2.8 165.7c-3.1-4.5-3.7-10.2-1.6-15.2s6.6-8.6 11.9-9.6L121 121 140.9 13.1c1-5.3 4.6-9.8 9.6-11.9s10.7-1.5 15.2 1.6L256 65.1 346.3 2.8c4.5-3.1 10.2-3.7 15.2-1.6zM352 256c0 53-43 96-96 96s-96-43-96-96s43-96 96-96s96 43 96 96zm32 0c0-70.7-57.3-128-128-128s-128 57.3-128 128s57.3 128 128 128s128-57.3 128-128z";
        case "grid":
            return "M352 256c0 22.2-1.2 43.6-3.3 64H163.3c-2.2-20.4-3.3-41.8-3.3-64s1.2-43.6 3.3-64H348.7c2.2 20.4 3.3 41.8 3.3 64zm28.8-64H503.9c5.3 20.5 8.1 41.9 8.1 64s-2.8 43.5-8.1 64H380.8c2.1-20.6 3.2-42 3.2-64s-1.1-43.4-3.2-64zm112.6-32H376.7c-10-63.9-29.8-117.4-55.3-151.6c78.3 20.7 142 77.5 171.9 151.6zm-149.1 0H167.7c6.1-36.4 15.5-68.6 27-94.7c10.5-23.6 22.2-40.7 33.5-51.5C239.4 3.2 248.7 0 256 0s16.6 3.2 27.8 13.8c11.3 10.8 23 27.9 33.5 51.5c11.6 26 20.9 58.2 27 94.7zm-209 0H18.6C48.6 85.9 112.2 29.1 190.6 8.4C165.1 42.6 145.3 96.1 135.3 160zM8.1 192H131.2c-2.1 20.6-3.2 42-3.2 64s1.1 43.4 3.2 64H8.1C2.8 299.5 0 278.1 0 256s2.8-43.5 8.1-64zM194.7 446.6c-11.6-26-20.9-58.2-27-94.6H344.3c-6.1 36.4-15.5 68.6-27 94.6c-10.5 23.6-22.2 40.7-33.5 51.5C272.6 508.8 263.3 512 256 512s-16.6-3.2-27.8-13.8c-11.3-10.8-23-27.9-33.5-51.5zM135.3 352c10 63.9 29.8 117.4 55.3 151.6C112.2 482.9 48.6 426.1 18.6 352H135.3zm358.1 0c-30 74.1-93.6 130.9-171.9 151.6c25.5-34.2 45.2-87.7 55.3-151.6H493.4z";
        case "battery":
        return "M192 32c0-17.7 14.3-32 32-32h64c17.7 0 32 14.3 32 32V64h64c35.3 0 64 28.7 64 64V448c0 35.3-28.7 64-64 64H128c-35.3 0-64-28.7-64-64V128c0-35.3 28.7-64 64-64h64V32zm32 352a16 16 0 0 0 0-32h-32a16 16 0 0 0 0 32h32zm0-96a16 16 0 0 0 0-32h-32a16 16 0 0 0 0 32h32zm-16-80a16 16 0 1 0 0-32 16 16 0 1 0 0 32zm96 176a16 16 0 1 0 0-32h-32a16 16 0 1 0 0 32h32zm0-96a16 16 0 1 0 0-32h-32a16 16 0 1 0 0 32h32zm0-80a16 16 0 1 0 0-32h-32a16 16 0 1 0 0 32h32zm80 192a16 16 0 1 0 0-32h-32a16 16 0 1 0 0 32h32zm0-96a16 16 0 1 0 0-32h-32a16 16 0 1 0 0 32h32zm0-80a16 16 0 1 0 0-32h-32a16 16 0 1 0 0 32h32z";
        case "home":
            return "M575.8 255.5c0 18-15 32.1-32 32.1h-32l.7 160.2c0 2.7-.2 5.4-.5 8.1V472c0 22.1-17.9 40-40 40H456c-1.1 0-2.2 0-3.3-.1c-1.4 .1-2.8 .1-4.2 .1H416 392c-22.1 0-40-17.9-40-40V448 384c0-17.7-14.3-32-32-32H256c-17.7 0-32 14.3-32 32v64 24c0 22.1-17.9 40-40 40H160 128.1c-1.5 0-3-.1-4.5-.2c-1.2 .1-2.4 .2-3.6 .2H104c-22.1 0-40-17.9-40-40V360c0-.9 0-1.9 .1-2.8V287.6H32c-18 0-32-14-32-32.1c0-9 3-17 10-24L266.4 8c7-7 15-8 22-8s15 2 21 7L564.8 231.5c8 7 12 15 11 24z";
    }
}

function getColor(source, target) {
    if (source === "solar") return "orange";
    if (source === "grid" || target === "grid") return "lightblue";
    if (source === "battery" || target === "battery") return "pink";
    if (source === "home" && target === "grid") return "lightblue";
    return "white";
}

function updateLinks() {
    linkElements.attr("d", d => {
        const sourceNode = nodes.find(n => n.id === d.source);
        const targetNode = nodes.find(n => n.id === d.target);
        return `M${sourceNode.x},${sourceNode.y} L${targetNode.x},${targetNode.y}`;
    });
}

updateLinks();

function animateFlow() {
    svg.selectAll(".flow")
        .data(links)
        .enter()
        .append("circle")
        .attr("class", "flow")
        .attr("r", 3)
        .attr("fill", d => getColor(d.source, d.target))
        .attr("opacity", 0.7)
        .call(animateFlowCircle);
}

function animateFlowCircle(circle) {
    circle
        .transition()
        .duration(2000)
        .attrTween("transform", translateAlong)
        .on("end", function() {
            d3.select(this).remove();
            animateFlow();
        });
}

function translateAlong(d) {
    const path = linkElements.filter(l => l.source === d.source && l.target === d.target).node();
    const l = path.getTotalLength();
    return function(t) {
        const p = path.getPointAtLength(t * l);
        return `translate(${p.x},${p.y})`;
    };
}

animateFlow();

function updateEnergyValues() {
fetch('<%= ingress_path %>/api/energy')
.then(response => response.json())
.then(data => {
    valueTexts.text(d => {
        switch(d.id) {
            case 'solar': 
                return `${data.solarDifference} kWh`;
            case 'grid': 
                return `↓ ${data.gridOutDifference} kWh\n↑ ${data.gridInDifference} kWh`;
            case 'battery': 
                return `↓ ${data.batteryDischargeDifference} kWh\n↑ ${data.batteryChargeDifference} kWh`;
            case 'home': 
                return `${data.loadDifference} kWh`;
        }
    });

    // Adjust text position for multi-line values
    valueTexts.attr("dy", d => (d.id === 'grid' || d.id === 'battery') ? "5em" : "5.5em");
})
.catch(error => console.error('Error fetching energy data:', error));
}

// Update energy values every 5 seconds
setInterval(updateEnergyValues, 5000);

// Initial update
updateEnergyValues();

