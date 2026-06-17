const ort = require('onnxruntime-node');
const { Jimp, intToRGBA } = require('jimp');

const ALL_LABELS = [
    'cloudy', 
    'dew', 
    'fogsmog', 
    'frost', 
    'glaze', 
    'hail', 
    'lightning', 
    'rain', 
    'rainbow', 
    'rime', 
    'sandstorm', 
    'shine', 
    'snow', 
    'sunrise'
];

const DEFAULT_FILTERED_LABELS = [
    'cloudy',
    'fogsmog',
    'rain',
    'shine',
    'rainbow',
    'snow'
];

/**
 * Preprocesses the image into an ONNX float32 tensor of shape [1, 3, 224, 224] (BGR, normalized to [0, 1]).
 * @param {string} imagePath 
 * @returns {Promise<ort.Tensor>}
 */
async function preprocessImage(imagePath) {
    const image = await Jimp.read(imagePath);
    image.resize({ w: 224, h: 224 });

    const width = 224;
    const height = 224;
    
    // Float32Array size is 1 * 3 * 224 * 224
    const float32Data = new Float32Array(3 * width * height);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const pixelIndex = (y * width + x);
            const hexColor = image.getPixelColor(x, y);
            const rgba = intToRGBA(hexColor);

            // ResNet expects BGR format from OpenCV, normalized to [0, 1]
            const r = rgba.r / 255.0;
            const g = rgba.g / 255.0;
            const b = rgba.b / 255.0;

            // BGR channel offsets
            float32Data[0 * width * height + pixelIndex] = b; // Blue
            float32Data[1 * width * height + pixelIndex] = g; // Green
            float32Data[2 * width * height + pixelIndex] = r; // Red
        }
    }

    const inputTensor = new ort.Tensor('float32', float32Data, [1, 3, 224, 224]);
    return inputTensor;
}

/**
 * Analyzes the weather condition of the given image, optionally restricting to a subset of labels.
 * @param {string} imagePath 
 * @param {string[]} [allowedLabels]
 * @returns {Promise<{ label: string, confidence: number, scores: { [key: string]: number } }>}
 */
async function determineWeather(imagePath, allowedLabels = DEFAULT_FILTERED_LABELS) {
    // Load model session
    const session = await ort.InferenceSession.create('./weather_model.onnx');
    
    // Preprocess image
    const inputTensor = await preprocessImage(imagePath);
    
    // Run inference
    const feeds = { input: inputTensor };
    const outputMap = await session.run(feeds);
    
    // Retrieve the output tensor (named 'output')
    const outputTensor = outputMap.output;
    const outputData = outputTensor.data; // Raw logits for all 14 classes

    // Filter down to allowed labels
    const targetLabels = allowedLabels.filter(label => ALL_LABELS.includes(label));
    
    // Get logits for allowed labels
    const targetLogits = targetLabels.map(label => {
        const index = ALL_LABELS.indexOf(label);
        return outputData[index];
    });

    // Apply Softmax over ONLY the allowed target logits
    const exps = targetLogits.map(val => Math.exp(val));
    const sumExps = exps.reduce((a, b) => a + b, 0);
    const probabilities = exps.map(exp => exp / sumExps);

    // Find the highest confidence class
    let maxIndex = 0;
    let maxProb = 0;
    const scores = {};

    probabilities.forEach((prob, i) => {
        const label = targetLabels[i];
        scores[label] = prob;
        if (prob > maxProb) {
            maxProb = prob;
            maxIndex = i;
        }
    });

    return {
        label: targetLabels[maxIndex],
        confidence: maxProb,
        scores
    };
}

module.exports = {
    determineWeather
};
