// World-map overlay tile shapes, copied from server/webclient/src/mapview/MapView.ts (drawOverlayShape).
// Only change: the target row stride is a parameter instead of Pix2D.width.
/* eslint-disable */
export function drawOverlayShape(data: Int32Array, off: number, underlay: number, overlay: number, width: number, height: number, shape: number, rotation: number, stride: number): void {
    const step: number = stride - width;
    if (shape == 9) {
        shape = 1;
        rotation = (rotation + 1) & 0x3;
    } else if (shape == 10) {
        shape = 1;
        rotation = (rotation + 3) & 0x3;
    } else if (shape == 11) {
        shape = 8;
        rotation = (rotation + 3) & 0x3;
    }

    if (shape == 1) {
        if (rotation == 0) {
            for (let y: number = 0; y < height; y++) {
                for (let x: number = 0; x < width; x++) {
                    if (x <= y) {
                        data[off++] = overlay;
                    } else {
                        data[off++] = underlay;
                    }
                }
                off += step;
            }
        } else if (rotation == 1) {
            for (let y: number = height - 1; y >= 0; y--) {
                for (let x: number = 0; x < width; x++) {
                    if (x <= y) {
                        data[off++] = overlay;
                    } else {
                        data[off++] = underlay;
                    }
                }
                off += step;
            }
        } else if (rotation == 2) {
            for (let y: number = 0; y < height; y++) {
                for (let x: number = 0; x < width; x++) {
                    if (x >= y) {
                        data[off++] = overlay;
                    } else {
                        data[off++] = underlay;
                    }
                }
                off += step;
            }
        } else if (rotation == 3) {
            for (let y: number = height - 1; y >= 0; y--) {
                for (let x: number = 0; x < width; x++) {
                    if (x >= y) {
                        data[off++] = overlay;
                    } else {
                        data[off++] = underlay;
                    }
                }
                off += step;
            }
        }
    } else if (shape == 2) {
        if (rotation == 0) {
            for (let y: number = height - 1; y >= 0; y--) {
                for (let x: number = 0; x < width; x++) {
                    if (x <= y >> 1) {
                        data[off++] = overlay;
                    } else {
                        data[off++] = underlay;
                    }
                }
                off += step;
            }
        } else if (rotation == 1) {
            for (let y: number = 0; y < height; y++) {
                for (let x: number = 0; x < width; x++) {
                    if (x >= y << 1) {
                        data[off++] = overlay;
                    } else {
                        data[off++] = underlay;
                    }
                }
                off += step;
            }
        } else if (rotation == 2) {
            for (let y: number = 0; y < height; y++) {
                for (let x: number = width - 1; x >= 0; x--) {
                    if (x <= y >> 1) {
                        data[off++] = overlay;
                    } else {
                        data[off++] = underlay;
                    }
                }
                off += step;
            }
        } else if (rotation == 3) {
            for (let y: number = height - 1; y >= 0; y--) {
                for (let x: number = width - 1; x >= 0; x--) {
                    if (x >= y << 1) {
                        data[off++] = overlay;
                    } else {
                        data[off++] = underlay;
                    }
                }
                off += step;
            }
        }
    } else if (shape == 3) {
        if (rotation == 0) {
            for (let y: number = height - 1; y >= 0; y--) {
                for (let x: number = width - 1; x >= 0; x--) {
                    if (x <= y >> 1) {
                        data[off++] = overlay;
                    } else {
                        data[off++] = underlay;
                    }
                }
                off += step;
            }
        } else if (rotation == 1) {
            for (let y: number = height - 1; y >= 0; y--) {
                for (let x: number = 0; x < width; x++) {
                    if (x >= y << 1) {
                        data[off++] = overlay;
                    } else {
                        data[off++] = underlay;
                    }
                }
                off += step;
            }
        } else if (rotation == 2) {
            for (let y: number = 0; y < height; y++) {
                for (let x: number = 0; x < width; x++) {
                    if (x <= y >> 1) {
                        data[off++] = overlay;
                    } else {
                        data[off++] = underlay;
                    }
                }
                off += step;
            }
        } else if (rotation == 3) {
            for (let y: number = 0; y < height; y++) {
                for (let x: number = width - 1; x >= 0; x--) {
                    if (x >= y << 1) {
                        data[off++] = overlay;
                    } else {
                        data[off++] = underlay;
                    }
                }
                off += step;
            }
        }
    } else if (shape == 4) {
        if (rotation == 0) {
            for (let y: number = height - 1; y >= 0; y--) {
                for (let x: number = 0; x < width; x++) {
                    if (x >= y >> 1) {
                        data[off++] = overlay;
                    } else {
                        data[off++] = underlay;
                    }
                }
                off += step;
            }
        } else if (rotation == 1) {
            for (let y: number = 0; y < height; y++) {
                for (let x: number = 0; x < width; x++) {
                    if (x <= y << 1) {
                        data[off++] = overlay;
                    } else {
                        data[off++] = underlay;
                    }
                }
                off += step;
            }
        } else if (rotation == 2) {
            for (let y: number = 0; y < height; y++) {
                for (let x: number = width - 1; x >= 0; x--) {
                    if (x >= y >> 1) {
                        data[off++] = overlay;
                    } else {
                        data[off++] = underlay;
                    }
                }
                off += step;
            }
        } else if (rotation == 3) {
            for (let y: number = height - 1; y >= 0; y--) {
                for (let x: number = width - 1; x >= 0; x--) {
                    if (x <= y << 1) {
                        data[off++] = overlay;
                    } else {
                        data[off++] = underlay;
                    }
                }
                off += step;
            }
        }
    } else if (shape == 5) {
        if (rotation == 0) {
            for (let y: number = height - 1; y >= 0; y--) {
                for (let x: number = width - 1; x >= 0; x--) {
                    if (x >= y >> 1) {
                        data[off++] = overlay;
                    } else {
                        data[off++] = underlay;
                    }
                }
                off += step;
            }
        } else if (rotation == 1) {
            for (let y: number = height - 1; y >= 0; y--) {
                for (let x: number = 0; x < width; x++) {
                    if (x <= y << 1) {
                        data[off++] = overlay;
                    } else {
                        data[off++] = underlay;
                    }
                }
                off += step;
            }
        } else if (rotation == 2) {
            for (let y: number = 0; y < height; y++) {
                for (let x: number = 0; x < width; x++) {
                    if (x >= y >> 1) {
                        data[off++] = overlay;
                    } else {
                        data[off++] = underlay;
                    }
                }
                off += step;
            }
        } else if (rotation == 3) {
            for (let y: number = 0; y < height; y++) {
                for (let x: number = width - 1; x >= 0; x--) {
                    if (x <= y << 1) {
                        data[off++] = overlay;
                    } else {
                        data[off++] = underlay;
                    }
                }
                off += step;
            }
        }
    } else if (shape == 6) {
        if (rotation == 0) {
            for (let y: number = 0; y < height; y++) {
                for (let x: number = 0; x < width; x++) {
                    if (x <= ((width / 2) | 0)) {
                        data[off++] = overlay;
                    } else {
                        data[off++] = underlay;
                    }
                }
                off += step;
            }
        } else if (rotation == 1) {
            for (let y: number = 0; y < height; y++) {
                for (let x: number = 0; x < width; x++) {
                    if (y <= ((height / 2) | 0)) {
                        data[off++] = overlay;
                    } else {
                        data[off++] = underlay;
                    }
                }
                off += step;
            }
        } else if (rotation == 2) {
            for (let y: number = 0; y < height; y++) {
                for (let x: number = 0; x < width; x++) {
                    if (x >= ((width / 2) | 0)) {
                        data[off++] = overlay;
                    } else {
                        data[off++] = underlay;
                    }
                }
                off += step;
            }
        } else if (rotation == 3) {
            for (let y: number = 0; y < height; y++) {
                for (let x: number = 0; x < width; x++) {
                    if (y >= ((height / 2) | 0)) {
                        data[off++] = overlay;
                    } else {
                        data[off++] = underlay;
                    }
                }
                off += step;
            }
        }
    } else if (shape == 7) {
        if (rotation == 0) {
            for (let y: number = 0; y < height; y++) {
                for (let x: number = 0; x < width; x++) {
                    if (x <= y - ((height / 2) | 0)) {
                        data[off++] = overlay;
                    } else {
                        data[off++] = underlay;
                    }
                }
                off += step;
            }
        } else if (rotation == 1) {
            for (let y: number = height - 1; y >= 0; y--) {
                for (let x: number = 0; x < width; x++) {
                    if (x <= y - ((height / 2) | 0)) {
                        data[off++] = overlay;
                    } else {
                        data[off++] = underlay;
                    }
                }
                off += step;
            }
        } else if (rotation == 2) {
            for (let y: number = height - 1; y >= 0; y--) {
                for (let x: number = width - 1; x >= 0; x--) {
                    if (x <= y - ((height / 2) | 0)) {
                        data[off++] = overlay;
                    } else {
                        data[off++] = underlay;
                    }
                }
                off += step;
            }
        } else if (rotation == 3) {
            for (let y: number = 0; y < height; y++) {
                for (let x: number = width - 1; x >= 0; x--) {
                    if (x <= y - ((height / 2) | 0)) {
                        data[off++] = overlay;
                    } else {
                        data[off++] = underlay;
                    }
                }
                off += step;
            }
        }
    } else if (shape == 8) {
        if (rotation == 0) {
            for (let y: number = 0; y < height; y++) {
                for (let x: number = 0; x < width; x++) {
                    if (x >= y - ((height / 2) | 0)) {
                        data[off++] = overlay;
                    } else {
                        data[off++] = underlay;
                    }
                }
                off += step;
            }
        } else if (rotation == 1) {
            for (let y: number = height - 1; y >= 0; y--) {
                for (let x: number = 0; x < width; x++) {
                    if (x >= y - ((height / 2) | 0)) {
                        data[off++] = overlay;
                    } else {
                        data[off++] = underlay;
                    }
                }
                off += step;
            }
        } else if (rotation == 2) {
            for (let y: number = height - 1; y >= 0; y--) {
                for (let x: number = width - 1; x >= 0; x--) {
                    if (x >= y - ((height / 2) | 0)) {
                        data[off++] = overlay;
                    } else {
                        data[off++] = underlay;
                    }
                }
                off += step;
            }
        } else if (rotation == 3) {
            for (let y: number = 0; y < height; y++) {
                for (let x: number = width - 1; x >= 0; x--) {
                    if (x >= y - ((height / 2) | 0)) {
                        data[off++] = overlay;
                    } else {
                        data[off++] = underlay;
                    }
                }
                off += step;
            }
        }
    }
}
